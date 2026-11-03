// P2-12（96 队列 #12）terminal 工具面 — 单工具五动作（CC 单工具多操作范
// 式，lsp 同款）：run / send / read / interrupt / exit。会话与 shell 状态跨
// 工具调用存活（cd/export/venv/交互式 CLI——本弧存在理由）。
//
// 纪律（shell 全继承 + PTY 特有）：
// - buildTool fail-closed 工厂：参数校验先于副作用（动作/命令/输入/行数/
//   会话名全在 execute 首段挡下）；任何失败都是 isError 工具错误。
// - 权限：每动作 ask 档——风险标注非只读/破坏性/open-world/非并发安全，
//   且不进 permission 的 READ_TOOLS/WORKSPACE_TOOLS（send 是新输入到任意
//   进程，v1 不做会话级信任继承，fail-safe）。
// - 输出：模型可见输出零 ANSI/控制序列（stripTerminalCodes 在 manager 出
//   口剥除，ring 存原始）；capOutputLines 同款截断。
// - history：全动作记 terminal 专项条目（session-entry.buildTerminalEntry
//   ——rewind_turn 同款缝），sink 由前端接线（appendSessionEntry），缺省
//   零条目（嵌入式边界，worktree_enter 的 store 由调用方持）。
// - 设置门控：settings `terminal.enabled` 缺省 false（misc-config.
//   resolveTerminalEnabled）+ node-pty 加载成功才注册（缺原生构建 → 启动
//   一条 warn 零注册零 fatal）。注册走 extraTools 列表尾（lsp 同款，
//   append-only，前缀字节稳定）。
// - 会话不经 JSONL 恢复：PTY 状态本质不可持久化，重启即清（诚实声明——
//   工具描述与 README 都写了）。
import { buildTool, capOutputLines, type Tool } from "@wudao-org/core";
import type { GenericSessionEntry } from "@wudao-org/core";
import { loadNodePty, terminalPtyStatus, type PtySpawnFn } from "./pty.js";
import { TerminalManager, TERMINAL_SETTLE_MAX_MS, validSessionName } from "./manager.js";
import { buildTerminalEntry as buildEntry, TERMINAL_ENTRY_TYPE } from "../session-entry.js";

export { buildTerminalEntry, TERMINAL_ENTRY_TYPE } from "../session-entry.js";

/** read 的行预算：缺省 50，上限 200（brief v1）。 */
export const TERMINAL_READ_DEFAULT_LINES = 50;
export const TERMINAL_READ_MAX_LINES = 200;

export interface TerminalToolDeps {
  /** 操作根（spawn cwd；进 worktree 后新会话跟根走——P1-7 缝）。 */
  readonly workspaceRoot: string;
  /** 注入 spawn（测试确定性）。缺省在首个动作时 await loadNodePty。 */
  readonly spawnFn?: PtySpawnFn;
  /** 注入 shell（测试确定性）。缺省 $SHELL → 平台缺省。 */
  readonly shell?: { readonly file: string; readonly args?: readonly string[] };
  readonly env?: NodeJS.ProcessEnv;
  readonly idleTimeoutMs?: number;
  readonly settleSilenceMs?: number;
  readonly settleMaxMs?: number;
  readonly maxSessions?: number;
  readonly ringMaxChars?: number;
  /** idle 回收 / 自然退出 notice 通道。 */
  readonly onNotice?: (message: string) => void;
}

/** Every live manager (drained by closeTerminalTools at frontend shutdown). */
const managers: TerminalManager[] = [];

/** Build the single `terminal` tool (one manager per tool instance, lazy spawn). */
export function createTerminalTool(deps: TerminalToolDeps): Tool {
  let manager: TerminalManager | undefined;
  const settleCapSecs = Math.round((deps.settleMaxMs ?? TERMINAL_SETTLE_MAX_MS) / 1000);
  const ensureManager = async (): Promise<TerminalManager> => {
    if (manager === undefined) {
      let spawnFn = deps.spawnFn;
      if (spawnFn === undefined) {
        // The tool only registers after a successful load, so this await is
        // the already-resolved cache — but direct constructions (embedders)
        // deserve the honest fail-closed error rather than a crash.
        const load = await loadNodePty();
        if (!load.ok) throw new Error(`terminal unavailable: ${load.reason}`);
        spawnFn = load.spawn;
      }
      manager = new TerminalManager({
        cwd: deps.workspaceRoot,
        spawnFn,
        ...(deps.shell !== undefined ? { shell: deps.shell } : {}),
        ...(deps.env !== undefined ? { env: deps.env } : {}),
        ...(deps.idleTimeoutMs !== undefined ? { idleTimeoutMs: deps.idleTimeoutMs } : {}),
        ...(deps.settleSilenceMs !== undefined ? { settleSilenceMs: deps.settleSilenceMs } : {}),
        ...(deps.settleMaxMs !== undefined ? { settleMaxMs: deps.settleMaxMs } : {}),
        ...(deps.maxSessions !== undefined ? { maxSessions: deps.maxSessions } : {}),
        ...(deps.ringMaxChars !== undefined ? { ringMaxChars: deps.ringMaxChars } : {}),
        ...(deps.onNotice !== undefined ? { onNotice: deps.onNotice } : {}),
      });
      managers.push(manager);
    }
    return manager;
  };

  return buildTool({
    name: "terminal",
    description:
      "A persistent PTY shell whose state (cwd, env vars, activated venvs, interactive CLIs) SURVIVES across tool calls — what shell cannot do. " +
      'actions: run (execute a command in the session and wait for output to settle) · send (write input to a running interactive program) · read (poll the session\'s recent output) · interrupt (Ctrl-C) · exit (close the session). ' +
      'Sessions are named (default "main"; at most 2 live); they idle-recycle after 10 minutes and are NEVER resumed after the process exits or a harness restart — shell state cannot be persisted. ' +
      "Prefer shell for one-shot commands (cheaper, sandboxable); use terminal for interactive CLIs, long-running services, or when shell state must carry between commands.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["run", "send", "read", "interrupt", "exit"], description: "run | send | read | interrupt | exit" },
        command: { type: "string", description: "run: the shell command to execute in the session." },
        input: { type: "string", description: 'send: the input to write (trailing newline added automatically; control characters like \\x03 pass through as-is).' },
        lines: { type: "number", description: "read: how many trailing lines to return (default 50, capped at 200)." },
        session: { type: "string", description: 'Session name (default "main"; at most 2 live sessions).' },
      },
      required: ["action"],
      additionalProperties: false,
    },
    // 每动作 ask 档（红线 2）：非只读 / 破坏性 / open-world / 非并发安全
    // ——fail-closed 默认值原样显式化。不进 permission 的 READ_TOOLS/
    // WORKSPACE_TOOLS：workspace/ask 模式下每个动作都要问。
    isReadOnly: () => false,
    isDestructive: () => true,
    isOpenWorld: () => true,
    isConcurrencySafe: () => false,
    execute: async (args: Record<string, unknown>): Promise<{ content: string; isError?: boolean }> => {
      const fail = (message: string): { content: string; isError: boolean } => ({ content: message, isError: true });
      // ---- 校验先于副作用（红线 2）----
      const action = args["action"];
      if (action !== "run" && action !== "send" && action !== "read" && action !== "interrupt" && action !== "exit") {
        return fail(`terminal: action must be "run" | "send" | "read" | "interrupt" | "exit" (got ${JSON.stringify(action)})`);
      }
      const rawSession = args["session"];
      const session = rawSession === undefined ? "main" : rawSession;
      if (!validSessionName(session)) {
        return fail(`terminal: "session" must be a non-empty name (≤64 chars, no control characters) — got ${JSON.stringify(rawSession)}`);
      }
      const name = session.trim();
      const command = args["command"];
      if (action === "run" && (typeof command !== "string" || command.trim() === "")) {
        return fail('terminal: "command" must be a non-empty string for action "run"');
      }
      const input = args["input"];
      if (action === "send" && typeof input !== "string") {
        return fail('terminal: "input" must be a string for action "send"');
      }
      const rawLines = args["lines"];
      let lines = TERMINAL_READ_DEFAULT_LINES;
      if (rawLines !== undefined) {
        if (typeof rawLines !== "number" || !Number.isInteger(rawLines) || rawLines < 1) {
          return fail(`terminal: "lines" must be a positive integer (got ${JSON.stringify(rawLines)})`);
        }
        lines = Math.min(rawLines, TERMINAL_READ_MAX_LINES);
      }
      // ---- 校验过了才记 history（红线 4：全动作审计条目）----
      historySink?.(buildEntry({
        action,
        session: name,
        ...(action === "run" && typeof command === "string" ? { command } : {}),
        ...(action === "send" && typeof input === "string" ? { input } : {}),
        ...(action === "read" && rawLines !== undefined ? { lines } : {}),
      }));
      // ---- 副作用 ----
      try {
        const m = await ensureManager();
        if (action === "run") {
          const out = await m.run(name, command as string);
          const tail = [
            `$ ${command as string}`,
            capOutputLines(out.output),
            out.settledByDeadline ? `[still running — output settled by the ${settleCapSecs}s cap; use {action:"read"} to poll]` : "",
            out.exitedDuringRun ? `[session "${name}" ended during this run — PTY state is gone; a later run needs a new session name]` : "",
          ].filter((l) => l !== "");
          return { content: tail.join("\n"), isError: false };
        }
        if (action === "send") {
          const out = await m.send(name, input as string);
          return { content: `[terminal:send session=${name}] ${out.bytes} bytes written — use {action:"read"} to see the response`, isError: false };
        }
        if (action === "read") {
          const out = await m.read(name, lines);
          return { content: capOutputLines(out.text), isError: false };
        }
        if (action === "interrupt") {
          await m.interrupt(name);
          return { content: `[terminal:interrupt session=${name}] SIGINT (Ctrl-C) written — use {action:"read"} to see the aftermath`, isError: false };
        }
        const out = await m.exit(name);
        const detail = `exit code ${out.exitDetail.exitCode}${out.exitDetail.signal !== undefined ? `, signal ${out.exitDetail.signal}` : ""}`;
        return { content: `[terminal:exit session=${name}] session closed (${detail})`, isError: false };
      } catch (err) {
        return fail(`terminal ${action} on session "${name}" failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Settings gate + the frontend seam (the lsp/MCP conditional-registration
// pattern: enabled AND loadable → the tool appends at the list tail; anything
// else → [], zero surface, never fatal).
// ---------------------------------------------------------------------------

let runtimeEnabled = false;

/** The boot-time settings gate (index.ts calls this once beside setLspRuntimeEnabled). */
export function setTerminalRuntimeEnabled(enabled: boolean): void {
  runtimeEnabled = enabled;
}

/** The current gate state (tests/diagnostics). */
export function terminalRuntimeEnabled(): boolean {
  return runtimeEnabled;
}

/** History sink: the frontends wire appendSessionEntry-backed closures. Absent → no entries. */
let historySink: ((entry: GenericSessionEntry) => void) | undefined;

export function setTerminalHistorySink(sink: ((entry: GenericSessionEntry) => void) | undefined): void {
  historySink = sink;
}

const toolCache = new Map<string, Tool>();

/**
 * The terminal tool for a workspace — [] while `terminal.enabled` is
 * unset/false OR node-pty failed to load. One cached tool per root: repeated
 * frontend calls share one manager. Registration is session-static and sync:
 * index.ts awaits warmTerminalPty at startup so the load verdict is already
 * settled (terminalPtyStatus is the resolved mirror of loadNodePty's memo).
 */
export function terminalToolsFor(workspaceRoot: string): Tool[] {
  if (!runtimeEnabled) return [];
  const load = terminalPtyStatus();
  if (load === undefined || !load.ok) return [];
  let tool = toolCache.get(workspaceRoot);
  if (tool === undefined) {
    tool = createTerminalTool({ workspaceRoot, spawnFn: load.spawn });
    toolCache.set(workspaceRoot, tool);
  }
  return [tool];
}

/** Dispose every live PTY session (bounded; called beside closeLspTools). */
export async function closeTerminalTools(): Promise<void> {
  const closing = managers.splice(0, managers.length);
  await Promise.all(closing.map((m) => m.dispose().catch(() => {})));
}

/** Fire-and-forget variant for process "exit" hooks. */
export function bestEffortCloseTerminalTools(): void {
  for (const m of managers.splice(0, managers.length)) {
    void m.dispose().catch(() => {});
  }
}

/** Test seam: full reset (gate, sink, tool cache). */
export function __resetTerminalRuntimeForTests(): void {
  runtimeEnabled = false;
  historySink = undefined;
  toolCache.clear();
}
