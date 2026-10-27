// P2-9（96 队列 #9）LSP 服务器生命周期管理 — 懒启动 / idle 回收 / 崩溃
// 重建 的策略层。LspClient 只管一个进程的协议；本层决定进程何时存在：
//
//   懒启动   零调用零进程——第一次请求才 spawn + 握手（起语言服务器是
//            成本与攻击面，opt-in 由 settings 门控在更上层）。
//   idle 回收  最后一次请求 settle 后 idleTimeoutMs 无新请求 → 有界关停
//            （shutdown→exit→EOF→SIGTERM→SIGKILL）。计时器 unref——绝不
//            拽住事件循环（CLI 退出不等它）。
//   崩溃重建  客户端 die → 状态清零；下一个请求重新 spawn。didOpen 缓存
//            属于进程代（client 实例），重建后自然重发。
//   超时     只废当次请求；服务器不杀（下次同进程可用）。
//
// 单飞（single-flight）：并发请求共享同一次启动；in-flight 计数压住
// idle 计时器。绝不挂死：每条 await 都在 LspClient 的超时/崩溃兜底内。
import { LspClient } from "./client.js";

/** How the manager launches one language server (the provider table's entry). */
export interface LspProviderLaunchSpec {
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

export interface LspManagerOptions {
  /** The workspace the server serves (spawn cwd + rootUri + path base). */
  readonly workspaceRoot: string;
  /** How to launch the server (resolved provider entry — see tools.ts). */
  readonly provider: LspProviderLaunchSpec;
  /** Per-request timeout ms. Default 10s (LSP_DEFAULT_REQUEST_TIMEOUT_MS). */
  readonly requestTimeoutMs?: number;
  /** The initialize roundtrip's budget. Default = requestTimeoutMs. */
  readonly initializeTimeoutMs?: number;
  /** Kill the server after this much idle time (no in-flight request). Default 5min. */
  readonly idleTimeoutMs?: number;
  /** Debug sink for server stderr lines. */
  readonly onStderr?: (line: string) => void;
}

export const LSP_DEFAULT_IDLE_TIMEOUT_MS = 5 * 60_000;

/** A document to sync before the request (the manager owns didOpen/didChange). */
export interface LspDocSync {
  readonly path: string;
  readonly languageId: string;
  readonly text: string;
}

export interface LspPosition1 {
  /** 1-based line (the tool surface's convention — converted here). */
  readonly line: number;
  /** 1-based column (converted to LSP's 0-based UTF-16 character offset). */
  readonly column: number;
}

type Phase =
  | { readonly kind: "idle" }
  | { readonly kind: "starting"; readonly promise: Promise<LspClient> }
  | { readonly kind: "ready"; readonly client: LspClient };

export class LspManager {
  private readonly opts: Required<Pick<LspManagerOptions, "requestTimeoutMs" | "idleTimeoutMs">> & LspManagerOptions;
  private phase: Phase = { kind: "idle" };
  private inFlight = 0;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(opts: LspManagerOptions) {
    this.opts = {
      ...opts,
      requestTimeoutMs: opts.requestTimeoutMs ?? 10_000,
      idleTimeoutMs: opts.idleTimeoutMs ?? LSP_DEFAULT_IDLE_TIMEOUT_MS,
    };
  }

  /** True while a server process is alive (starting, or ready and not dead). */
  hasServer(): boolean {
    if (this.phase.kind === "idle") return false;
    if (this.phase.kind === "ready") return !this.phase.client.isDead;
    return true; // starting
  }

  /**
   * One roundtrip against the (lazily started) server: ensures the server is
   * up + handshaked, syncs the document (didOpen/didChange once per text),
   * sends the request with the 1-based → 0-based position conversion.
   */
  async request(method: string, doc: LspDocSync, position: LspPosition1, extraParams?: Record<string, unknown>): Promise<unknown> {
    if (this.disposed) throw new Error("LSP manager is disposed");
    this.inFlight += 1;
    this.disarmIdle();
    try {
      const client = await this.ensureServer();
      const uri = client.openDocument(doc);
      return await client.request(method, {
        textDocument: { uri },
        position: { line: position.line - 1, character: position.column - 1 },
        ...(extraParams !== undefined ? extraParams : {}),
      }, { timeoutMs: this.opts.requestTimeoutMs });
    } finally {
      this.inFlight -= 1;
      this.armIdle();
    }
  }

  /** references carries an includeDeclaration context member — same lifecycle. */
  references(doc: LspDocSync, position: LspPosition1, includeDeclaration: boolean): Promise<unknown> {
    return this.request("textDocument/references", doc, position, { context: { includeDeclaration } });
  }

  /** Spawn + handshake, single-flight. Failure resets to idle (next call retries). */
  private ensureServer(): Promise<LspClient> {
    if (this.phase.kind === "ready") {
      const { client } = this.phase;
      if (!client.isDead) return Promise.resolve(client);
      // The client died between requests — drop it; a fresh start follows.
      this.phase = { kind: "idle" };
    }
    if (this.phase.kind === "starting") return this.phase.promise;
    const promise = this.start();
    this.phase = { kind: "starting", promise };
    return promise;
  }

  private async start(): Promise<LspClient> {
    if (this.disposed) throw new Error("LSP manager is disposed");
    const client = new LspClient({
      command: this.opts.provider.command,
      args: this.opts.provider.args,
      env: this.opts.provider.env,
      workspaceRoot: this.opts.workspaceRoot,
      timeoutMs: this.opts.requestTimeoutMs,
      ...(this.opts.initializeTimeoutMs !== undefined ? { initializeTimeoutMs: this.opts.initializeTimeoutMs } : {}),
      ...(this.opts.onStderr !== undefined ? { onStderr: this.opts.onStderr } : {}),
    });
    // A crash DURING the handshake must reset state for the next attempt.
    client.initialize().then(
      () => {
        if (this.phase.kind === "starting") this.phase = { kind: "ready", client };
      },
      () => {
        // start()'s await below rejects first; this clears the starting slot
        // if a concurrent caller never awaited this branch.
        if (this.phase.kind === "starting") this.phase = { kind: "idle" };
      },
    );
    try {
      await client.initialize();
    } catch (err) {
      if (this.phase.kind === "starting") this.phase = { kind: "idle" };
      void client.close().catch(() => {});
      throw err;
    }
    return client;
  }

  /** Arm the idle reaper (only when nothing is in flight and a server lives). */
  private armIdle(): void {
    this.disarmIdle();
    if (this.disposed || this.inFlight > 0 || this.phase.kind === "idle") return;
    // unref: the timer must never hold the event loop open (CLI exit, vitest).
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      if (this.inFlight > 0 || this.phase.kind === "idle") return;
      const client = this.phase.kind === "ready" ? this.phase.client : undefined;
      this.phase = { kind: "idle" };
      if (client !== undefined) void client.close().catch(() => {});
    }, this.opts.idleTimeoutMs);
    this.idleTimer.unref?.();
  }

  private disarmIdle(): void {
    if (this.idleTimer !== undefined) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  /** Kill the server (bounded) and stop the manager. Idempotent. */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.disarmIdle();
    const client = this.phase.kind === "ready" ? this.phase.client : undefined;
    this.phase = { kind: "idle" };
    if (client !== undefined) await client.close().catch(() => {});
  }
}
