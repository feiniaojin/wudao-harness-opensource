// Minimal stdio JSON-RPC 2.0 client (M17) — hand-written, zero dependencies.
//
// The MCP transport is newline-delimited JSON over the child process's
// stdin/stdout: one JSON object per line. This class owns the child process
// (spawned WITHOUT a shell — the configured command is executed directly),
// a buffered stdout line parser that skips malformed lines, request-id
// correlation for concurrent requests, and a fail-closed lifecycle (process
// death rejects all pending requests).
import { spawn, type ChildProcess } from "node:child_process";
import { homedir } from "node:os";
import { capTraceBody, capTraceDetail, parseTraceEnv, type McpFrameRecord } from "./trace.js";

export interface JsonRpcClientOptions {
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  /** Default per-request timeout in ms (each request may override). Default 120_000. */
  readonly timeoutMs?: number;
  /** Per-line stdout/stderr buffer cap. Default 1 MiB. */
  readonly maxLineBytes?: number;
  /** Grace period after stdin EOF before SIGTERM in close(). Default 2_000. */
  readonly shutdownGraceMs?: number;
  /** Grace period after SIGTERM before SIGKILL in close(). Default 1_500. */
  readonly killGraceMs?: number;
  /** Debug sink for server stderr lines. */
  readonly onStderr?: (line: string) => void;
  /** ω-5a I20: frame-trace sink override (the test seam — the onStderr
   *  precedent). Absent → WUDAO_MCP_TRACE decides (unset = fully off). */
  readonly trace?: (r: McpFrameRecord) => void;
}

const DEFAULT_MAX_LINE_BYTES = 1_048_576;
const DEFAULT_SHUTDOWN_GRACE_MS = 2_000;
const DEFAULT_KILL_GRACE_MS = 1_500;

/** The user-bin dirs a GUI-launched process must still be able to reach.
 *  macOS apps started from Finder/Dock inherit launchd's bare PATH
 *  (`/usr/bin:/bin:/usr/sbin:/sbin`) — it lacks ~/.local/bin (uvx itself),
 *  the brew bin dirs (and /usr/local/bin/realpath, which uvx-generated
 *  wrapper scripts exec on line 2). Pure + synchronous for unit tests. */
export function augmentChildPath(path: string | undefined, home: string): string {
  const seen = new Set<string>();
  const entries = (path && path.length > 0 ? path : "/usr/bin:/bin:/usr/sbin:/sbin")
    .split(":")
    .filter((e) => e.length > 0);
  for (const e of entries) seen.add(e);
  // Append-only: nothing already on PATH is reordered or shadowed.
  for (const extra of [`${home}/.local/bin`, "/opt/homebrew/bin", "/usr/local/bin", `${home}/bin`]) {
    if (!seen.has(extra)) {
      seen.add(extra);
      entries.push(extra);
    }
  }
  return entries.join(":");
}

/** JSON-RPC error response (`error` member present). */
export class JsonRpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.name = "JsonRpcError";
    this.code = code;
  }
}

export class JsonRpcTimeoutError extends Error {
  constructor(method: string, timeoutMs: number) {
    super(`JSON-RPC request "${method}" timed out after ${timeoutMs}ms`);
    this.name = "JsonRpcTimeoutError";
  }
}

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (err: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  /** ω-5a I20: request-send time — the response record's latencyMs base. */
  readonly sentAt: number;
}

export class JsonRpcClient {
  private readonly child: ChildProcess;
  private readonly pending = new Map<number | string, Pending>();
  private readonly onStderr?: (line: string) => void;
  private readonly defaultTimeoutMs: number;
  private readonly maxLineBytes: number;
  private readonly shutdownGraceMs: number;
  private readonly killGraceMs: number;
  private nextId = 1;
  private stdoutBuf = "";
  private stderrBuf = "";
  private dead = false;
  private closed = false;
  /** Spawned detached (own process group) — close() can then group-kill. */
  private readonly grouped: boolean;
  /** ω-5a I20: the frame-trace sink (undefined = off). */
  private readonly trace?: (r: McpFrameRecord) => void;
  /** Review M2: one-shot latch for the sink-failure stderr note. */
  private traceSinkNoted = false;
  /** Resolves when the child process has fully exited. */
  private readonly exited: Promise<void>;

  constructor(opts: JsonRpcClientOptions) {
    this.onStderr = opts.onStderr;
    this.defaultTimeoutMs = opts.timeoutMs ?? 120_000;
    this.maxLineBytes = opts.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
    this.shutdownGraceMs = opts.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
    this.killGraceMs = opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    this.trace = opts.trace ?? parseTraceEnv(process.env.WUDAO_MCP_TRACE)?.sink;
    // POSIX: own process group — stdio MCP commands are usually wrappers
    // (uvx → python) whose grandchildren must die with the connection;
    // kill(-pid) in close() reaches the whole tree. win32 detached means
    // something else entirely (new console) — skip it there.
    this.grouped = process.platform !== "win32";
    this.child = spawn(opts.command, opts.args ?? [], {
      shell: false, // never — the configured command runs directly, no injection surface
      // PATH augmentation BEFORE opts.env: a GUI-launched parent carries
      // launchd's bare PATH (no ~/.local/bin, no brew) and stdio servers
      // commonly live exactly there; an explicit PATH in the server config
      // still wins (spread last).
      env: { ...process.env, PATH: augmentChildPath(process.env.PATH, homedir()), ...opts.env },
      stdio: ["pipe", "pipe", "pipe"],
      // No console window for a console-subsystem server spawned from the
      // console-less desktop sidecar (closing one would kill the server).
      windowsHide: true,
      ...(this.grouped ? { detached: true } : {}),
    });
    // "error" (spawn failure — no exit event is ever emitted in that case)
    // must also settle this promise or close() would hang forever.
    this.exited = new Promise((resolve) => {
      this.child.once("exit", () => resolve());
      this.child.once("error", () => resolve());
    });
    this.child.stdout?.setEncoding("utf8");
    this.child.stdout?.on("data", (chunk: string) => this.onStdoutChunk(chunk));
    this.child.stderr?.setEncoding("utf8");
    this.child.stderr?.on("data", (chunk: string) => this.onStderrChunk(chunk));
    this.traceFrame({ ts: new Date().toISOString(), dir: "lifecycle", bytes: 0, detail: capTraceDetail(`spawn ${opts.command}${(opts.args?.length ?? 0) > 0 ? ` ${(opts.args as readonly string[]).join(" ")}` : ""}`) });
    // Spawn failure (ENOENT etc.) or a crashed server must reject every
    // pending and all FUTURE requests — fail-closed, never a hung promise.
    this.child.once("error", (err) => this.die(new Error(`MCP server failed to start: ${err.message}`)));
    this.child.once("exit", (code, signal) => {
      this.die(new Error(`MCP server exited unexpectedly (${signal ? `signal ${signal}` : `code ${code ?? "?"}`})`));
    });
  }

  /** ω-5a I20: emit one trace record (no-op when tracing is off). Review M2
   *  (fix round): a throwing sink (full disk, unwritable path, closed
   *  stderr) must never take the transport down — the error is swallowed
   *  after ONE stderr note; tracing continues best-effort. */
  private traceFrame(r: McpFrameRecord): void {
    if (this.trace === undefined) return;
    try {
      this.trace(r);
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

  /** Send a request and resolve with the `result` member of the response. */
  request(method: string, params: unknown, opts?: { readonly timeoutMs?: number }): Promise<unknown> {
    if (this.dead || this.closed) {
      return Promise.reject(new Error("MCP server connection is closed"));
    }
    const id = this.nextId++;
    const timeoutMs = opts?.timeoutMs ?? this.defaultTimeoutMs;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.traceFrame({ ts: new Date().toISOString(), dir: "lifecycle", method, id, bytes: 0, detail: capTraceDetail(`timeout: ${method} did not respond within ${timeoutMs}ms`) });
        reject(new JsonRpcTimeoutError(method, timeoutMs));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, sentAt: Date.now() });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  /** Fire-and-forget notification (no id, never a response). */
  notify(method: string, params: unknown): void {
    if (this.dead || this.closed) return;
    this.write({ jsonrpc: "2.0", method, params });
  }

  /** Graceful shutdown: EOF on stdin → ≤grace → SIGTERM → ≤killGrace → SIGKILL.
   *  Every wait is bounded — a server that traps SIGTERM can never hang the
   *  CLI on shutdown. Idempotent. The escalation ladder runs on the whole
   *  process GROUP (and runs even when the direct child already exited on
   *  EOF — a dying wrapper like uvx leaves its grandchild, the real server,
   *  behind in the group). */
  async close(): Promise<void> {
    if (this.closed) {
      await this.exited;
      return;
    }
    this.closed = true;
    this.child.stdin?.end();
    const grace = this.timer(this.shutdownGraceMs);
    try {
      await Promise.race([this.exited, grace.promise]);
    } finally {
      grace.clear();
    }
    this.killTree("SIGTERM");
    const killGrace = this.timer(this.killGraceMs);
    try {
      await Promise.race([this.exited, killGrace.promise]);
    } finally {
      killGrace.clear();
    }
    // SIGKILL cannot be trapped — exit is imminent, no further wait needed.
    this.killTree("SIGKILL");
    this.die(new Error("MCP server connection closed"));
  }

  /** Signal the child's whole process group; falls back to the direct child
   *  (win32, or the group already empty). kill(-pid) after the group leader
   *  died still reaches surviving members — that IS the orphan case. */
  private killTree(sig: NodeJS.Signals): void {
    const pid = this.child.pid;
    if (pid !== undefined && this.grouped) {
      try {
        process.kill(-pid, sig);
        return;
      } catch {
        // ESRCH: the group is empty — everyone already exited.
      }
    }
    try {
      this.child.kill(sig);
    } catch {
      // already dead
    }
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  /** Exit code of the child process, or null while it is still running. */
  get childExitCode(): number | null {
    return this.child.exitCode;
  }

  /** Signal that killed the child (e.g. "SIGKILL"), or null. */
  get childSignal(): string | null {
    return this.child.signalCode;
  }

  private timer(ms: number): { promise: Promise<void>; clear: () => void } {
    let handle: ReturnType<typeof setTimeout> | undefined;
    const promise = new Promise<void>((resolve) => {
      handle = setTimeout(resolve, ms);
    });
    return { promise, clear: () => { if (handle !== undefined) clearTimeout(handle); } };
  }

  private write(msg: unknown): void {
    const payload = JSON.stringify(msg);
    this.child.stdin?.write(`${payload}\n`);
    if (this.trace === undefined) return;
    const m = msg as { method?: unknown; id?: unknown };
    this.traceFrame({
      ts: new Date().toISOString(),
      dir: "→",
      ...(typeof m.method === "string" ? { method: m.method } : {}),
      ...(typeof m.id === "number" ? { id: m.id } : {}),
      bytes: Buffer.byteLength(payload, "utf8"),
      // Bodies ride the record capped; the header-mode sink strips them.
      body: capTraceBody(payload),
    });
  }

  private onStdoutChunk(chunk: string): void {
    this.stdoutBuf += chunk;
    // A single line larger than the cap is a hostile/broken server — drop the
    // partial line and hard-error the connection (bounded memory).
    if (this.stdoutBuf.length > this.maxLineBytes) {
      this.abortConnection(`MCP server stdout line exceeded ${this.maxLineBytes} bytes`);
      return;
    }
    // Newline-delimited JSON: only complete lines are parseable. The tail
    // stays buffered until its terminating newline arrives.
    let idx = this.stdoutBuf.indexOf("\n");
    while (idx !== -1) {
      const line = this.stdoutBuf.slice(0, idx);
      this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
      this.handleLine(line);
      idx = this.stdoutBuf.indexOf("\n");
    }
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: unknown;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return; // malformed line — skip, keep the stream usable
    }
    if (typeof msg !== "object" || msg === null) return;
    const { id, result, error } = msg as { id?: unknown; result?: unknown; error?: { code?: unknown; message?: unknown } };
    // MCP allows number OR string ids (spec: string/number). We only SEND
    // number ids, but must accept string ids back per spec.
    if (typeof id !== "number" && typeof id !== "string") return; // notification — ignored
    const pending = this.pending.get(id);
    if (!pending) return; // stale (timed-out) response
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (this.trace !== undefined) {
      const latencyMs = Math.max(0, Date.now() - pending.sentAt);
      this.traceFrame({
        ts: new Date().toISOString(),
        dir: "←",
        ...(typeof id === "number" ? { id } : {}),
        bytes: Buffer.byteLength(trimmed, "utf8"),
        latencyMs,
        body: capTraceBody(trimmed),
      });
      if (error !== undefined) {
        this.traceFrame({ ts: new Date().toISOString(), dir: "lifecycle", ...(typeof id === "number" ? { id } : {}), bytes: 0, detail: capTraceDetail(`error response: ${typeof error.code === "number" ? error.code : -32603} ${typeof error.message === "string" ? error.message : "unknown JSON-RPC error"}`) });
      }
    }
    if (error !== undefined) {
      pending.reject(new JsonRpcError(typeof error.code === "number" ? error.code : -32603, typeof error.message === "string" ? error.message : "unknown JSON-RPC error"));
    } else {
      pending.resolve(result);
    }
  }

  private onStderrChunk(chunk: string): void {
    this.stderrBuf += chunk;
    if (this.stderrBuf.length > this.maxLineBytes) {
      this.abortConnection(`MCP server stderr line exceeded ${this.maxLineBytes} bytes`);
      return;
    }
    let idx = this.stderrBuf.indexOf("\n");
    while (idx !== -1) {
      const line = this.stderrBuf.slice(0, idx);
      this.stderrBuf = this.stderrBuf.slice(idx + 1);
      if (line.trim() && this.onStderr) this.onStderr(line);
      idx = this.stderrBuf.indexOf("\n");
    }
  }

  /** Hard-error the connection: reject everything pending and future, kill
   *  the child (it already misbehaved — no graceful signals). */
  private abortConnection(reason: string): void {
    this.stdoutBuf = "";
    this.stderrBuf = "";
    this.die(new Error(`${reason}; connection aborted`));
    try {
      this.child.kill("SIGKILL");
    } catch {
      // already dead — nothing to do
    }
  }

  private die(err: Error): void {
    if (this.dead) return;
    this.dead = true;
    this.traceFrame({ ts: new Date().toISOString(), dir: "lifecycle", bytes: 0, detail: capTraceDetail(err.message) });
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
  }
}
