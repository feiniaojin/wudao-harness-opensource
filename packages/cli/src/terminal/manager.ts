// P2-12（96 队列 #12）持久 PTY 会话管理 — LspManager 同款生命周期纪律
//（懒 spawn / idle 回收 unref 计时器 / 失败 fail-closed），对象换成了
// 跨调用存活的 shell 会话（本弧存在理由：cd/export/venv 状态在工具调用
// 之间保持）。
//
//   懒 spawn     零动作零进程——第一次 run 才 spawn shell。
//   settle      run = 写入命令 + 等输出静默（settleSilenceMs，缺省 200ms）
//               或 settleMaxMs（缺省 5s）上限；进程中途退出也算 settle。
//   ring buffer 每会话 256KB 原始字符（含 ANSI——剥除只在出口），溢出丢
//               头保尾 + overflowed 标记。
//   idle 回收   最后一次动作后 idleTimeoutMs（缺省 10min）无新动作 → 有界
//               kill + notice。回收是 harness 记账：会话干净移除（同名
//               run = 全新 shell，无 tombstone）。
//   自然退出    进程自己退了 → 保留 tombstone：后续所有动作（含 run）报
//               “会话已结束”——PTY 状态不可恢复，诚实不自动重开。
//   kill 阶梯   exit：SIGHUP → 2s → SIGKILL → 最多 2.5s 后无论如何清理。
//
// 单飞纪律同 LSP：动作自增 inFlight 压住 idle 计时器（动作期间的输出活
// 跃不会触发回收）；计时器 unref——绝不拽住事件循环（CLI 退出 / vitest）。
import { truncateSafe, truncateTailSafe } from "@wudao/core"; // 113-A4
import { scrubChildEnv } from "@wudao/core";
import type { PtyProcess, PtySpawnFn } from "./pty.js";
import { stripTerminalCodes } from "./ansi.js";

/** 命名会话上限（"main" + 1 个命名；brief v1 窄收）。 */
export const TERMINAL_MAX_SESSIONS = 2;
/** 每会话 ring buffer 上限（原始字符数 ≈ UTF-8 字节下界）。 */
export const TERMINAL_RING_MAX_CHARS = 256 * 1024;
/** idle 回收窗口（LSP manager 同款纪律，缺省 10 分钟）。 */
export const TERMINAL_DEFAULT_IDLE_TIMEOUT_MS = 10 * 60_000;
/** run 的 settle 静默窗与总上限。 */
export const TERMINAL_SETTLE_SILENCE_MS = 200;
export const TERMINAL_SETTLE_MAX_MS = 5_000;
/** exit 的 kill 阶梯：SIGHUP 后 2s 升 SIGKILL，2.5s 兜底放行。 */
const EXIT_SIGKILL_GRACE_MS = 2_000;
const EXIT_HARD_DROP_MS = EXIT_SIGKILL_GRACE_MS + 500;
const POLL_MS = 25;

export interface TerminalManagerOptions {
  /** spawn cwd（操作根——进 worktree 后新会话跟根走的缝在 tools 层）。 */
  readonly cwd: string;
  /** 子进程 env。缺省 shell 同款纪律：scrubChildEnv()。 */
  readonly env?: NodeJS.ProcessEnv;
  /** 注入 shell（测试确定性）。缺省 $SHELL → 平台缺省。 */
  readonly shell?: { readonly file: string; readonly args?: readonly string[] };
  /** 注入 spawn（fake 测试）。产品路径来自 loadNodePty。 */
  readonly spawnFn: PtySpawnFn;
  readonly idleTimeoutMs?: number;
  readonly settleSilenceMs?: number;
  readonly settleMaxMs?: number;
  readonly maxSessions?: number;
  readonly ringMaxChars?: number;
  /** 时钟注入（idle 计时与审计）。 */
  readonly now?: () => number;
  /** idle 回收 notice 通道。 */
  readonly onNotice?: (message: string) => void;
}

export interface RunOutcome {
  readonly session: string;
  /** settle 窗口内捕获的输出（ANSI 已剥除）。 */
  readonly output: string;
  /** true = settle 是总上限咬的（长任务可能还在跑——用 read 轮询）。 */
  readonly settledByDeadline: boolean;
  /** 进程在本次 run 窗口内退出。 */
  readonly exitedDuringRun: boolean;
  readonly exitDetail?: { readonly exitCode: number; readonly signal?: number };
}

export interface ReadOutcome {
  readonly session: string;
  /** 尾部 N 行（ANSI 已剥除；溢出时头部带丢头标记）。 */
  readonly text: string;
  readonly lines: number;
  readonly overflowed: boolean;
}

interface Session {
  readonly name: string;
  proc: PtyProcess;
  ring: string;
  overflowed: boolean;
  alive: boolean;
  /** tombstone = 进程已退；live 计数只算 alive。 */
  closed: boolean;
  exitDetail?: { exitCode: number; signal?: number };
  lastDataAt: number;
  idleTimer: ReturnType<typeof setTimeout> | undefined;
  dataSub: { dispose(): void } | undefined;
  exitSub: { dispose(): void } | undefined;
  /** run 捕获窗：仅 run 活动期间收集；独立于 ring（ring 丢头不影响捕获）。 */
  pendingCapture: string | undefined;
  captureSawData: boolean;
}

function defaultShell(env: NodeJS.ProcessEnv): { file: string; args?: readonly string[] } {
  const fromEnv = typeof env["SHELL"] === "string" && env["SHELL"].trim() !== "" ? env["SHELL"].trim() : undefined;
  if (fromEnv !== undefined) return { file: fromEnv };
  return { file: process.platform === "darwin" ? "/bin/zsh" : "/bin/bash" };
}

/** 会话名纪律：trim 后非空、≤64 字符、无控制字符（fail-closed）。 */
export function validSessionName(raw: unknown): raw is string {
  if (typeof raw !== "string") return false;
  const t = raw.trim();
  return t !== "" && t.length <= 64 && !/[\x00-\x1f\x7f]/.test(t);
}

export class TerminalManager {
  private readonly opts: Required<Pick<TerminalManagerOptions, "idleTimeoutMs" | "settleSilenceMs" | "settleMaxMs" | "maxSessions" | "ringMaxChars">> & TerminalManagerOptions;
  private readonly sessions = new Map<string, Session>();
  private inFlight = 0;
  private disposed = false;
  private envCache: NodeJS.ProcessEnv | undefined;

  constructor(opts: TerminalManagerOptions) {
    this.opts = {
      ...opts,
      idleTimeoutMs: opts.idleTimeoutMs ?? TERMINAL_DEFAULT_IDLE_TIMEOUT_MS,
      settleSilenceMs: opts.settleSilenceMs ?? TERMINAL_SETTLE_SILENCE_MS,
      settleMaxMs: opts.settleMaxMs ?? TERMINAL_SETTLE_MAX_MS,
      maxSessions: opts.maxSessions ?? TERMINAL_MAX_SESSIONS,
      ringMaxChars: opts.ringMaxChars ?? TERMINAL_RING_MAX_CHARS,
    };
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  private notice(message: string): void {
    this.opts.onNotice?.(message);
  }

  /** 活会话名（按创建序）。tombstone 不算。 */
  liveSessions(): readonly string[] {
    const names: string[] = [];
    for (const s of this.sessions.values()) if (s.alive) names.push(s.name);
    return names;
  }

  /** 活会话 pid（“同一进程跨调用”断言用）。 */
  sessionPid(name: string): number | undefined {
    const s = this.sessions.get(name);
    return s !== undefined && s.alive ? s.proc.pid : undefined;
  }

  private armIdle(s: Session): void {
    this.disarmIdle(s);
    if (this.disposed || !s.alive) return;
    // unref: the timer must never hold the event loop open (CLI exit, vitest).
    s.idleTimer = setTimeout(() => {
      s.idleTimer = undefined;
      if (this.inFlight > 0 || !s.alive) return;
      void this.closeSession(s, "idle").catch(() => {});
    }, this.opts.idleTimeoutMs);
    s.idleTimer.unref?.();
  }

  private disarmIdle(s: Session): void {
    if (s.idleTimer !== undefined) {
      clearTimeout(s.idleTimer);
      s.idleTimer = undefined;
    }
  }

  /**
   * One manager-scoped action: in-flight counting holds every session's idle
   * timer down for the duration (actions are short; run ≤ settleMaxMs).
   */
  private async action<T>(fn: () => Promise<T>): Promise<T> {
    if (this.disposed) throw new Error("terminal manager is disposed");
    this.inFlight += 1;
    for (const s of this.sessions.values()) this.disarmIdle(s);
    try {
      return await fn();
    } finally {
      this.inFlight -= 1;
      for (const s of this.sessions.values()) this.armIdle(s);
    }
  }

  private liveList(): string {
    const live = this.liveSessions();
    return live.length > 0 ? live.join(", ") : "(none)";
  }

  /** 会话不存在的 fail-closed 文案。 */
  private noSession(name: string): Error {
    return new Error(`terminal: no session "${name}" (live: ${this.liveList()})`);
  }

  /** 会话已结束的 fail-closed 文案（自然退出 / 显式 exit 的 tombstone）。 */
  private ended(s: Session): Error {
    const d = s.exitDetail !== undefined
      ? ` (exit code ${s.exitDetail.exitCode}${s.exitDetail.signal !== undefined ? `, signal ${s.exitDetail.signal}` : ""})`
      : "";
    return new Error(`terminal: session "${s.name}" has ended${d} — PTY sessions are never resumed; start a fresh one under a new session name`);
  }

  private resolvedEnv(): NodeJS.ProcessEnv {
    if (this.envCache === undefined) this.envCache = this.opts.env ?? scrubChildEnv();
    return this.envCache;
  }

  private spawnSession(name: string): Session {
    const shell = this.opts.shell ?? defaultShell(this.resolvedEnv());
    const proc = this.opts.spawnFn(shell.file, shell.args !== undefined ? [...shell.args] : [], {
      name: "xterm-256color",
      cwd: this.opts.cwd,
      env: this.resolvedEnv() as Record<string, string>,
      cols: 120,
      rows: 30,
    });
    const s: Session = {
      name,
      proc,
      ring: "",
      overflowed: false,
      alive: true,
      closed: false,
      lastDataAt: this.now(),
      idleTimer: undefined,
      dataSub: undefined,
      exitSub: undefined,
      pendingCapture: undefined,
      captureSawData: false,
    };
    // Subscriptions built against the final session object (handlers read s).
    s.dataSub = proc.onData((data) => this.onData(s, data));
    s.exitSub = proc.onExit((e) => this.onExit(s, e));
    this.sessions.set(name, s);
    return s;
  }

  private onData(s: Session, data: string): void {
    s.lastDataAt = this.now();
    s.ring += data;
    if (s.ring.length > this.opts.ringMaxChars) {
      s.ring = truncateTailSafe(s.ring, this.opts.ringMaxChars);
      s.overflowed = true;
    }
    if (s.pendingCapture !== undefined) {
      s.pendingCapture += data;
      s.captureSawData = true;
    }
  }

  private onExit(s: Session, e: { exitCode: number; signal?: number }): void {
    if (s.closed) return;
    s.alive = false;
    s.closed = true;
    s.exitDetail = { exitCode: e.exitCode, ...(e.signal !== undefined ? { signal: e.signal } : {}) };
    this.disarmIdle(s);
    try { s.dataSub?.dispose(); } catch { /* native may race */ }
    try { s.exitSub?.dispose(); } catch { /* native may race */ }
  }

  /**
   * 有界关停一条会话（SIGHUP → SIGKILL 阶梯，≤2.5s）。reason 决定死后
   * 形态：idle / dispose → 干净移除（同名 run = 全新 shell）；exit（模型
   * 显式）→ 保留 tombstone（后续动作报“已结束”）。
   */
  private async closeSession(s: Session, reason: "exit" | "idle" | "dispose"): Promise<void> {
    this.disarmIdle(s);
    if (s.alive) {
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = (): void => {
          if (settled) return;
          settled = true;
          resolve();
        };
        const drop = setTimeout(finish, EXIT_HARD_DROP_MS);
        drop.unref?.();
        const sub = s.proc.onExit(() => {
          clearTimeout(drop);
          try { sub.dispose(); } catch { /* already gone */ }
          finish();
        });
        try {
          s.proc.kill("SIGHUP");
        } catch { finish(); }
        const esk = setTimeout(() => {
          try { s.proc.kill("SIGKILL"); } catch { /* already gone */ }
        }, EXIT_SIGKILL_GRACE_MS);
        esk.unref?.();
      });
    }
    if (!s.closed) this.onExit(s, { exitCode: 0 });
    if (reason === "idle" || reason === "dispose") {
      this.sessions.delete(s.name);
      if (reason === "idle") {
        this.notice(`terminal: session "${s.name}" reaped after idle (${Math.round(this.opts.idleTimeoutMs / 1000)}s) — its shell state is gone; a new run under the same name starts a fresh shell`);
      }
    }
    // reason === "exit": tombstone stays — post-exit actions read "ended".
  }

  /** run 入口：活会话或新 spawn；上限与 tombstone 语义都在这里。 */
  private ensureSession(name: string): Session {
    const existing = this.sessions.get(name);
    if (existing !== undefined) {
      if (existing.closed || !existing.alive) throw this.ended(existing);
      return existing;
    }
    const live = this.liveSessions();
    if (live.length >= this.opts.maxSessions) {
      throw new Error(`terminal: session limit (${this.opts.maxSessions}) reached; live sessions: ${live.join(", ")} — exit one first ({action:"exit", session:"…"})`);
    }
    return this.spawnSession(name);
  }

  /** run：发命令 + settle（输出静默或总上限，进程退出也 settle）。 */
  async run(session: string, command: string): Promise<RunOutcome> {
    if (!validSessionName(session)) throw new Error(`terminal: "session" must be a non-empty name (≤64 chars, no control characters) — got ${JSON.stringify(session)}`);
    if (typeof command !== "string" || command.trim() === "") throw new Error('terminal: "command" must be a non-empty string');
    return this.action(async () => {
      const s = this.ensureSession(session.trim());
      const startedAt = this.now();
      s.pendingCapture = "";
      s.captureSawData = false;
      try {
        s.proc.write(`${command}\n`);
        const deadline = startedAt + this.opts.settleMaxMs;
        for (;;) {
          await sleep(POLL_MS);
          const now = this.now();
          const quiet = s.captureSawData && now - s.lastDataAt >= this.opts.settleSilenceMs;
          const byDeadline = now >= deadline;
          if (!s.alive || quiet || byDeadline) {
            return {
              session,
              output: stripTerminalCodes(s.pendingCapture ?? ""),
              settledByDeadline: byDeadline && !quiet && s.alive,
              exitedDuringRun: !s.alive,
              ...(s.exitDetail !== undefined && !s.alive ? { exitDetail: s.exitDetail } : {}),
            };
          }
        }
      } finally {
        s.pendingCapture = undefined;
        s.captureSawData = false;
      }
    });
  }

  /** send：向活会话写输入；尾补 \n 除非尾部已是控制字符（\x03 等）。 */
  async send(session: string, input: string): Promise<{ session: string; bytes: number }> {
    return this.action(async () => {
      const s = this.sessions.get(session);
      if (s === undefined) throw this.noSession(session);
      if (s.closed || !s.alive) throw this.ended(s);
      const last = input.length > 0 ? (input[input.length - 1] ?? "") : "";
      const lastIsControl = last !== "" && last !== "\n" && last !== "\r" && last !== "\t" && last.charCodeAt(0) < 0x20;
      const payload = last === "" || last === "\n" || last === "\r" || lastIsControl ? input : `${input}\n`;
      s.proc.write(payload);
      return { session, bytes: payload.length };
    });
  }

  /** read：ring 尾部 N 行（剥除后；lines 缺省 50，上限 200）。已结束的会话
   *  fail-closed（brief：exit 后动作报会话结束——读尾巴也不例外）。 */
  async read(session: string, lines = 50): Promise<ReadOutcome> {
    return this.action(async () => {
      const n = Math.max(1, Math.min(200, Math.floor(lines)));
      const s = this.sessions.get(session);
      if (s === undefined) throw this.noSession(session);
      if (s.closed || !s.alive) throw this.ended(s);
      const body = tailLines(stripTerminalCodes(s.ring), n);
      const marker = s.overflowed ? `… (older output dropped — ring buffer capped at ${Math.round(this.opts.ringMaxChars / 1024)}KB)\n` : "";
      return {
        session,
        text: `${marker}${body}`,
        lines: n,
        overflowed: s.overflowed,
      };
    });
  }

  /** interrupt：Ctrl-C 语义（\x03）。 */
  async interrupt(session: string): Promise<{ session: string }> {
    return this.action(async () => {
      const s = this.sessions.get(session);
      if (s === undefined) throw this.noSession(session);
      if (s.closed || !s.alive) throw this.ended(s);
      s.proc.write("\x03");
      return { session };
    });
  }

  /** exit：kill 阶梯 + tombstone（后续动作报已结束）。 */
  async exit(session: string): Promise<{ session: string; exitDetail: { exitCode: number; signal?: number } }> {
    return this.action(async () => {
      const s = this.sessions.get(session);
      if (s === undefined) throw this.noSession(session);
      if (s.closed || !s.alive) throw this.ended(s);
      await this.closeSession(s, "exit");
      return { session, exitDetail: s.exitDetail ?? { exitCode: 0 } };
    });
  }

  /** 全量有界关停（frontend shutdown / 测试清理）。Idempotent。 */
  async dispose(): Promise<void> {
    this.disposed = true;
    const closing = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(closing.map((s) => this.closeSession(s, "dispose").catch(() => {})));
  }
}

/** 尾部 N 行（保留行结构；空文本 → 占位说明）。 */
function tailLines(text: string, n: number): string {
  if (text.trim() === "") return "(no output yet in this session)";
  const lines = text.split("\n");
  return lines.slice(Math.max(0, lines.length - n)).join("\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
