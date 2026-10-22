// P2-9（96 队列 #9）LSP 客户端 — 一个语言服务器子进程的 Content-Length
// 帧协议客户端。独立实现（JsonRpcClient/core 零改动）：MCP 是
// newline-JSONL，LSP 是 `Content-Length: N\r\n\r\n{json}` 长度分帧。
//
// 生命周期纪律（fail-closed，绝不挂死）：
// - 每个请求带超时；超时只废该请求，连接保持可用。
// - 子进程 error/exit、帧垃圾、超帽消息 → die()：所有 pending 立即拒绝、
//   之后的一切请求立即拒绝（重建是上层 LspManager 的职责）。
// - close() 有界：shutdown → exit 通知 → stdin EOF → ≤2s → SIGTERM →
//   ≤1.5s → SIGKILL（陷阱服务器也杀得掉，CLI 永不挂起）。
// - server→client 请求（typescript-language-server 握手后必发
//   client/registerCapability、workspace/configuration 等）必须应答，否则
//   真服务器楔死——自动回良性 result。
// - 通知（无 id）不入响应等待，直接丢弃。
// - didOpen 惰性缓存（每文档一次）；文本变化走 didChange 全量同步
//   （textDocumentSync:1），保证会话内编辑后定义/悬浮不陈旧。
import { truncateSafe, truncateTailSafe } from "@wudao/core"; // 113-A4
import { spawn, type ChildProcess } from "node:child_process";
import { pathToFileURL } from "node:url";
import { encodeLspFrame, LspFrameDecoder } from "./frame.js";

export interface LspClientOptions {
  /** Executable (spawned WITHOUT a shell — run directly, no injection face). */
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  /** The workspace the server serves — spawn cwd + rootUri. */
  readonly workspaceRoot: string;
  /** Default per-request timeout ms (each request may override). Default 10s. */
  readonly timeoutMs?: number;
  /** The initialize roundtrip's own budget. Default = timeoutMs. */
  readonly initializeTimeoutMs?: number;
  /** Grace after stdin EOF before SIGTERM in close(). Default 2s. */
  readonly shutdownGraceMs?: number;
  /** Grace after SIGTERM before SIGKILL in close(). Default 1.5s. */
  readonly killGraceMs?: number;
  /** Debug sink for server stderr lines. */
  readonly onStderr?: (line: string) => void;
}

export const LSP_DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_SHUTDOWN_GRACE_MS = 2_000;
const DEFAULT_KILL_GRACE_MS = 1_500;
const STDERR_LINE_CAP = 1_048_576;

/** JSON-RPC error response (the `error` member present). */
export class LspRpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.name = "LspRpcError";
    this.code = code;
  }
}

export class LspTimeoutError extends Error {
  constructor(method: string, timeoutMs: number) {
    super(`LSP request "${method}" timed out after ${timeoutMs}ms`);
    this.name = "LspTimeoutError";
  }
}

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (err: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/** One document's sync state (didOpen/didChange cache — full text sync). */
interface OpenDoc {
  readonly languageId: string;
  version: number;
  text: string;
}

export class LspClient {
  private readonly child: ChildProcess;
  private readonly pending = new Map<number | string, Pending>();
  private readonly decoder = new LspFrameDecoder();
  private readonly defaultTimeoutMs: number;
  private readonly initializeTimeoutMs: number;
  private readonly shutdownGraceMs: number;
  private readonly killGraceMs: number;
  private readonly onStderr?: (line: string) => void;
  private nextId = 1;
  private dead = false;
  private closed = false;
  private diedReason: Error | undefined;
  private stdoutLive = true;
  private stderrBuf = "";
  private readonly openDocs = new Map<string, OpenDoc>();
  /** didOpen is keyed by URI (the server's identity for a document). */
  private readonly uriByPath = new Map<string, string>();
  private initializePromise: Promise<void> | undefined;
  private readonly exited: Promise<void>;
  private readonly rootDir: string;

  constructor(opts: LspClientOptions) {
    this.rootDir = opts.workspaceRoot;
    this.defaultTimeoutMs = opts.timeoutMs ?? LSP_DEFAULT_REQUEST_TIMEOUT_MS;
    this.initializeTimeoutMs = opts.initializeTimeoutMs ?? this.defaultTimeoutMs;
    this.shutdownGraceMs = opts.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
    this.killGraceMs = opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    this.onStderr = opts.onStderr;
    this.child = spawn(opts.command, opts.args ?? [], {
      shell: false,
      cwd: opts.workspaceRoot,
      env: { ...process.env, ...opts.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.exited = new Promise((resolve) => {
      this.child.once("exit", () => resolve());
      this.child.once("error", () => resolve());
    });
    this.child.stdout?.on("data", (chunk: Buffer) => this.onStdoutChunk(chunk));
    this.child.stderr?.setEncoding("utf8");
    this.child.stderr?.on("data", (chunk: string) => this.onStderrChunk(chunk));
    // Spawn failure (ENOENT etc.) or a crashed server must reject every
    // pending and all FUTURE requests — fail-closed, never a hung promise.
    this.child.once("error", (err) => this.die(new Error(`LSP server failed to start: ${err.message}`)));
    this.child.once("exit", (code, signal) => {
      // A child dying while close() is draining is the LADDER working, not a
      // crash — the post-close error must read "closed", never "unexpected".
      this.die(this.closed
        ? new Error("LSP server connection closed")
        : new Error(`LSP server exited unexpectedly (${signal !== null && signal !== undefined ? `signal ${signal}` : `code ${code ?? "?"}`})`));
    });
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  /** Signal that killed the child (e.g. "SIGKILL"), or null while alive. */
  get childSignal(): string | null {
    return this.child.signalCode;
  }

  /** True once the process is gone or the connection failed — dead for good. */
  get isDead(): boolean {
    return this.dead;
  }

  /** The LSP initialize → initialized handshake. Idempotent + single-flight. */
  initialize(): Promise<void> {
    this.initializePromise ??= this.runInitialize();
    return this.initializePromise;
  }

  private async runInitialize(): Promise<void> {
    await this.request(
      "initialize",
      {
        processId: process.pid,
        rootUri: pathToFileURL(this.rootDir).href,
        capabilities: {
          textDocument: {
            hover: { contentFormat: ["markdown", "plaintext"] },
            definition: { linkSupport: false },
            references: {},
            synchronization: { dynamicRegistration: false, didSave: false },
          },
          workspace: { configuration: true, workspaceFolders: false },
        },
        workspaceFolders: [{ uri: pathToFileURL(this.rootDir).href, name: "workspace" }],
        clientInfo: { name: "wudao-harness-lsp", version: "1" },
      },
      { timeoutMs: this.initializeTimeoutMs },
    );
    this.notify("initialized", {});
  }

  /** Send a request and resolve with the `result` member of the response. */
  request(method: string, params: unknown, opts?: { readonly timeoutMs?: number }): Promise<unknown> {
    if (this.dead || this.closed) {
      return Promise.reject(this.diedReason ?? new Error("LSP server connection is closed"));
    }
    return this.sendRequest(method, params, opts?.timeoutMs ?? this.defaultTimeoutMs);
  }

  /** Fire-and-forget notification (no id, never a response). */
  notify(method: string, params: unknown): void {
    if (this.dead || this.closed) return;
    this.write({ jsonrpc: "2.0", method, params });
  }

  /** The raw request path — no closed-check (close()'s own shutdown rides it). */
  private sendRequest(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.dead) {
      return Promise.reject(this.diedReason ?? new Error("LSP server connection is closed"));
    }
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new LspTimeoutError(method, timeoutMs));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  /**
   * Ensure the server has this document open with this exact text (full-sync
   * didOpen/didChange). Same text → no frame (the didOpen cache).
   */
  openDocument(doc: { readonly path: string; readonly languageId: string; readonly text: string }): string {
    const uri = this.uriFor(doc.path);
    const existing = this.openDocs.get(uri);
    if (existing === undefined) {
      this.openDocs.set(uri, { languageId: doc.languageId, version: 1, text: doc.text });
      this.notify("textDocument/didOpen", {
        textDocument: { uri, languageId: doc.languageId, version: 1, text: doc.text },
      });
      return uri;
    }
    if (existing.text !== doc.text) {
      existing.version += 1;
      existing.text = doc.text;
      this.notify("textDocument/didChange", {
        textDocument: { uri, version: existing.version },
        contentChanges: [{ text: doc.text }],
      });
    }
    return uri;
  }

  /** The URI the server knows a workspace path by (stable per path). */
  uriFor(path: string): string {
    let uri = this.uriByPath.get(path);
    if (uri === undefined) {
      uri = pathToFileURL(path).href;
      this.uriByPath.set(path, uri);
    }
    return uri;
  }

  /** Graceful shutdown ladder — every wait bounded, idempotent. */
  async close(): Promise<void> {
    if (this.closed) {
      await this.exited;
      return;
    }
    this.closed = true;
    // Best-effort LSP shutdown (bounded); a dead/garbage server just falls
    // through to the signal ladder. sendRequest/write bypass the closed check
    // — the ladder itself is the close.
    try {
      await this.sendRequest("shutdown", undefined, Math.min(this.shutdownGraceMs, 2_000));
      this.write({ jsonrpc: "2.0", method: "exit", params: undefined });
    } catch {
      // already dead or unresponsive — the ladder below still terminates it
    }
    this.child.stdin?.end();
    const eof = this.timer(this.shutdownGraceMs);
    try {
      await Promise.race([this.exited, eof.promise]);
    } finally {
      eof.clear();
    }
    if (this.child.exitCode === null && !this.child.killed) {
      this.child.kill("SIGTERM");
      const term = this.timer(this.killGraceMs);
      try {
        await Promise.race([this.exited, term.promise]);
      } finally {
        term.clear();
      }
      if (this.child.exitCode === null) {
        this.child.kill("SIGKILL"); // cannot be trapped
      }
    }
    this.die(new Error("LSP server connection closed"));
  }

  private timer(ms: number): { promise: Promise<void>; clear: () => void } {
    let handle: ReturnType<typeof setTimeout> | undefined;
    const promise = new Promise<void>((resolve) => {
      handle = setTimeout(resolve, ms);
    });
    return { promise, clear: () => { if (handle !== undefined) clearTimeout(handle); } };
  }

  private write(msg: unknown): void {
    const frame = encodeLspFrame(msg);
    this.child.stdin?.write(frame);
  }

  private onStdoutChunk(chunk: Buffer): void {
    if (!this.stdoutLive) return;
    let messages: unknown[];
    try {
      messages = this.decoder.push(chunk);
    } catch (err) {
      // Unframed garbage / oversized frame: the transport is broken — kill
      // the child (it already misbehaved) and fail everything closed.
      this.stdoutLive = false;
      this.die(new Error(err instanceof Error ? err.message : String(err)));
      try {
        this.child.kill("SIGKILL");
      } catch {
        // already dead
      }
      return;
    }
    for (const msg of messages) this.handleMessage(msg);
  }

  private handleMessage(msg: unknown): void {
    if (typeof msg !== "object" || msg === null) return;
    const { id, method, params, result, error } = msg as {
      id?: unknown; method?: unknown; params?: unknown; result?: unknown;
      error?: { code?: unknown; message?: unknown };
    };
    const hasId = typeof id === "number" || typeof id === "string";
    if (typeof method === "string") {
      if (hasId) {
        // Server→client REQUEST (id + method): must be answered or a real
        // server (typescript-language-server) wedges waiting on it.
        this.write({ jsonrpc: "2.0", id, result: serverRequestResult(method, params) });
      }
      // else: notification (no id) — never enters the response wait.
      return;
    }
    if (!hasId) return; // a response-shaped frame without id — nothing to pair
    const pending = this.pending.get(id as number | string);
    if (pending === undefined) return; // stale (timed-out) response
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (error !== undefined) {
      pending.reject(new LspRpcError(
        typeof error.code === "number" ? error.code : -32603,
        typeof error.message === "string" ? error.message : "unknown JSON-RPC error",
      ));
    } else {
      pending.resolve(result);
    }
  }

  private onStderrChunk(chunk: string): void {
    this.stderrBuf += chunk;
    if (this.stderrBuf.length > STDERR_LINE_CAP) this.stderrBuf = truncateTailSafe(this.stderrBuf, STDERR_LINE_CAP);
    let idx = this.stderrBuf.indexOf("\n");
    while (idx !== -1) {
      const line = this.stderrBuf.slice(0, idx);
      this.stderrBuf = this.stderrBuf.slice(idx + 1);
      if (line.trim() && this.onStderr) this.onStderr(line);
      idx = this.stderrBuf.indexOf("\n");
    }
  }

  private die(err: Error): void {
    if (this.dead) {
      this.diedReason ??= err;
      return;
    }
    this.dead = true;
    this.diedReason = err;
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
  }
}

/** Benign auto-answer for a server→client request (the wedge guard). */
function serverRequestResult(method: string, params: unknown): unknown {
  if (method === "workspace/configuration") {
    const items = (typeof params === "object" && params !== null
      ? (params as { items?: unknown }).items
      : undefined);
    return Array.isArray(items) ? items.map(() => null) : [];
  }
  return null; // client/registerCapability, window/workDoneProgress/create, …
}
