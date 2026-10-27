// 持久 bash（prime-agent #3640 引进弧）——长程任务基建：一个跨工具调用、
// 跨任务边界（压缩摘要的 Outstanding Work 会点名它）、乃至跨 harness 重启
// （记录面）存活的后台 shell。
//
// prime 的机制（runtime/src/rlm/bash.py 的 persistent 分支）：
//   · shell 记录在 <agent-dir>/persistent-shells/<id>.json，输出 <id>.out、
//     退出码 <id>.rc（运行中缺席）；
//   · 重挂按 identity 而非 pid——pid 会被复用，拿旧 pid 去认/杀进程会误中
//     陌生人（prime 的核心教训：startId 进程起始身份校验）；
//   · 输出 head+tail 封顶窗口；
//   · 会话删除/归档不杀 shell（只有自身退出或显式 kill）。
//
// wudao 的落法（取范式不照抄）：
//   · 存储 = <root>/.wudao/shells/ 下三件套：记录 JSON + <id>.out（head 4KB
//     + tail 4KB 封顶窗口，超限中段 [... N bytes truncated ...]，追加即维护）
//     + <id>.rc（退出码，运行中缺席）。record 永不存 pid——identity 是
//     contentHash(command+createdAt)（同一启动事件的同一字节），读取时校验，
//     防腐改/错配；liveness 判定只用「.rc 在不在 + lastSeenAt 新不新」，从不
//     探测 pid（identity-not-pid 的 wudao 形）。
//   · 进程注册表 = 本进程内存 Map<id, child>（进程内管理 kill；spawn
//     detached+unref 自成进程组）。只有注册表里的 child 会被信号——盘上
//     记录的 pid 我们根本没存，跨进程永不击杀（诚实拒绝，不赌 pid）。
//   · crash 后重挂：listPersistentShells 发现记录但注册表没有——.rc 缺席且
//     lastSeenAt 超时（grace 缺省 5min，本进程的活 shell 由心跳持续 touch）
//     → 判定死：shell_read 报「进程已消失，输出保留」。grace 内的未拥有
//     记录按 running（他进程所有）如实报。
//   · 孤儿清理 pruneStaleShells：lastSeenAt 超过 maxAge（缺省 7 天）的三件
//     套整体删除（含运行中样子的死壳——孤儿最终也是垃圾）。
//
// 诚实边界（与 prime 的偏差，弧记档）：
//   · 输出走 harness 内泵（child pipe → appendShellOutput 封顶落盘），不是
//     prime 的直接文件 fd。代价：harness 进程死亡后泵停，子进程下次写
//     stdout 触发 EPIPE 随即死——「重启后 shell 继续跑」不承诺；承诺的是
//     记录面：重启后 shell_read 仍能读回封顶窗口 + 如实的进程已消失判定。
//     收益：.out 文件本身有界（8KB 窗 + 标记），watch 进程跑一周也填不了盘
//     （prime 的文件无界、只在读时封顶）。
//   · 会话删除天然不杀 shell：存储锚在工作区（.wudao/shells），不随会话
//     走——prime 语义免费获得。
//
// M24 契约声明：shell 状态文件与对话历史完全正交（零缓存代价）；工具
// schema 进 tools 列表 = 跨版本一次性冷点（append-only 尾纪律），会话内
// 前缀字节稳定。
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { truncateSafe, truncateTailSafe } from "./text-truncate.js";
import { scrubChildEnv } from "./tools/shell.js";

// ---------------------------------------------------------------------------
// 常量（单一真值点；测试与 cli 层引用）
// ---------------------------------------------------------------------------

/** .out 窗口的头段与尾段上限（UTF-16 chars ≈ KB 口径；截断走 113-A4 原语）。 */
export const PERSISTENT_SHELL_OUT_HEAD_CHARS = 4096;
export const PERSISTENT_SHELL_OUT_TAIL_CHARS = 4096;
/** 未拥有记录的死亡判定宽限：.rc 缺席且 lastSeenAt 超过此窗 → 进程已消失。 */
export const PERSISTENT_SHELL_ORPHAN_GRACE_MS = 5 * 60_000;
/** 孤儿清理的年龄线（缺省 7 天；lastSeenAt 起算——活 shell 由心跳续命）。 */
export const PERSISTENT_SHELL_PRUNE_MS = 7 * 24 * 60 * 60_000;
/** 活 shell 的 lastSeenAt 心跳周期（未拥有判定的保鲜来源）。 */
export const PERSISTENT_SHELL_HEARTBEAT_MS = 60_000;
/** 单工作区的同时存活持久 shell 上限（registry 并发上限 16 的同款纪律）。 */
export const PERSISTENT_SHELL_MAX_ALIVE = 16;
/** 输出泵的合批刷新间隔（child 数据事件 → .out 的延迟上限）。 */
export const PERSISTENT_SHELL_FLUSH_MS = 150;
/** 单次待刷缓冲的硬顶（防火瀑布：超顶立即同步刷，窗口逻辑在盘上收口）。 */
const PENDING_FLUSH_CHARS = 64 * 1024;
/** stop 的 kill 阶梯：TERM → 2s → KILL（shell/execWithGroupKill 同款）。 */
const STOP_SIGKILL_GRACE_MS = 2_000;
/** stop 等待 close 的有界窗（超窗按已停收口——信号已发，group 必死）。 */
const STOP_CLOSE_WAIT_MS = 3_000;

const byteLen = (s: string): number => Buffer.byteLength(s, "utf8");

// ---------------------------------------------------------------------------
// 记录 + 输出文件（纯存储层；全部同步——文件 ≤ ~8.3KB，调用点在数据回调里）
// ---------------------------------------------------------------------------

/** 一条持久 shell 的磁盘记录。identity = contentHash(command+createdAt)——
 *  记录身份而非进程身份：wudao 永不把 pid 写盘（pid 复用误认的根除），
 *  读取时校验 identity，防错配/腐改。lastSeenAt 是 liveness 证据的时钟。 */
export interface PersistentShellRecord {
  readonly id: string;
  /** ISO 时间戳。 */
  readonly createdAt: string;
  readonly command: string;
  readonly identity: string;
  /** ISO 时间戳——最后一次「本进程见到它活着」的证据（追加/心跳/收尾时触）。 */
  readonly lastSeenAt: string;
}

/** 记录身份：同一 (command, createdAt) 启动事件 → 同一字节（NUL 分隔——
 *  createdAt 恒为 ISO（不含 NUL），分隔无歧义）。纯函数。 */
export function shellRecordIdentity(command: string, createdAt: string): string {
  return createHash("sha256").update(`${command}\u0000${createdAt}`).digest("hex").slice(0, 16);
}

/** 三件套的家：<root>/.wudao/shells/（工作区锚——会话删除不碰它）。 */
export function persistentShellDir(root: string): string {
  return join(root, ".wudao", "shells");
}

const recordPath = (root: string, id: string): string => join(persistentShellDir(root), `${id}.json`);
const outPath = (root: string, id: string): string => join(persistentShellDir(root), `${id}.out`);
const rcPath = (root: string, id: string): string => join(persistentShellDir(root), `${id}.rc`);

const nowIso = (): string => new Date().toISOString();

/** 原子写（tmp+rename——崩溃窗口不留半个文件）。 */
const atomicWrite = (path: string, text: string): void => {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, path);
};

/** 读单条记录并校验 identity（不匹配/损坏 → undefined，fail-closed 读）。 */
function readShellRecord(root: string, id: string): PersistentShellRecord | undefined {
  let raw: string;
  try {
    raw = readFileSync(recordPath(root, id), "utf8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const r = parsed as Partial<PersistentShellRecord> | null;
  if (r === null || typeof r !== "object") return undefined;
  if (typeof r.id !== "string" || typeof r.command !== "string") return undefined;
  if (typeof r.createdAt !== "string" || typeof r.lastSeenAt !== "string") return undefined;
  if (typeof r.identity !== "string") return undefined;
  if (r.identity !== shellRecordIdentity(r.command, r.createdAt)) return undefined;
  return {
    id: r.id,
    createdAt: r.createdAt,
    command: r.command,
    identity: r.identity,
    lastSeenAt: r.lastSeenAt,
  };
}

/** 建档：记录 JSON（原子）+ 空 .out。失败抛出（调用方收口为 typed 错误）。 */
export function createShellRecord(root: string, command: string): PersistentShellRecord {
  const createdAt = nowIso();
  const record: PersistentShellRecord = {
    id: randomBytes(6).toString("hex"),
    createdAt,
    command,
    identity: shellRecordIdentity(command, createdAt),
    lastSeenAt: createdAt,
  };
  const dir = persistentShellDir(root);
  mkdirSync(dir, { recursive: true });
  atomicWrite(recordPath(root, record.id), JSON.stringify(record));
  writeFileSync(outPath(root, record.id), "", "utf8");
  return record;
}

/** 全部记录，createdAt 升序（同刻按 id 字典序——字节确定的列表）。 */
export function listPersistentShells(root: string): readonly PersistentShellRecord[] {
  let names: string[];
  try {
    names = readdirSync(persistentShellDir(root));
  } catch {
    return [];
  }
  const records: PersistentShellRecord[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const record = readShellRecord(root, name.slice(0, -".json".length));
    if (record !== undefined) records.push(record);
  }
  return records.sort((a, b) =>
    a.createdAt !== b.createdAt ? (a.createdAt < b.createdAt ? -1 : 1) : a.id < b.id ? -1 : 1,
  );
}

/** 读输出窗口（.out 本身就是封顶窗口——原样读回；缺失 → ""）。 */
export function readShellOutput(root: string, id: string): string {
  try {
    return readFileSync(outPath(root, id), "utf8");
  } catch {
    return "";
  }
}

/** 读退出码：运行中/缺失 → undefined（.rc 缺席即「尚未收尾」的判定面）。 */
export function shellExitCode(root: string, id: string): number | undefined {
  try {
    return Number.parseInt(readFileSync(rcPath(root, id), "utf8").trim(), 10);
  } catch {
    return undefined;
  }
}

/** 窗口中段标记的形状（解析与渲染的单一真值点）。 */
const truncatedMarker = (droppedBytes: number): string => `\n[... ${droppedBytes} bytes truncated ...]\n`;
const MARKER_RE = /\n\[\.\.\. (\d+) bytes truncated \.\.\.\]\n/;

/** 把 .out 现文拆回 {head, dropped, tail}：无标记 = 全量连续文本。 */
function parseWindow(text: string): { head: string; dropped: number; tail: string } {
  const m = MARKER_RE.exec(text);
  if (m === null) return { head: text, dropped: 0, tail: "" };
  return {
    head: text.slice(0, m.index),
    dropped: Number(m[1]),
    tail: text.slice(m.index + m[0].length),
  };
}

/** 封顶追加：.out 始终是 head(≤4KB)+[标记]+tail(≤4KB) 的有界窗口。
 *  无标记期（总量 ≤ 8KB）文件就是全量；首次溢出定头劈尾，此后头冻结、
 *  尾滚动、中段计数只增（字节口径，被丢弃的是真实消失的字节）。追加同时
 *  触 lastSeenAt（泵活着的证据）。已知病态：子进程输出自身包含标记文本会
 *  误判为已定窗（计数失真，窗口仍正确有界）——接受（与 M46 头尾 shaping
 *  同款诚实边界）。失败抛出（泵侧吞掉，继续排水）。 */
export function appendShellOutput(root: string, id: string, chunk: string): void {
  const prev = readShellOutput(root, id);
  let text: string;
  const win = parseWindow(prev);
  if (win.dropped === 0 && win.tail === "") {
    // 无标记：连续全量。窗口内 → 原样追加；溢出 → 首次定窗。
    const full = prev + chunk;
    if (full.length <= PERSISTENT_SHELL_OUT_HEAD_CHARS + PERSISTENT_SHELL_OUT_TAIL_CHARS) {
      text = full;
    } else {
      const head = truncateSafe(full, PERSISTENT_SHELL_OUT_HEAD_CHARS);
      const tail = truncateTailSafe(full, PERSISTENT_SHELL_OUT_TAIL_CHARS);
      text = head + truncatedMarker(byteLen(full) - byteLen(head) - byteLen(tail)) + tail;
    }
  } else {
    // 已定窗：头冻结，新字节滚进尾；尾溢出的部分计入中段（字节口径）。
    let tail = win.tail + chunk;
    let dropped = win.dropped;
    if (tail.length > PERSISTENT_SHELL_OUT_TAIL_CHARS) {
      const kept = truncateTailSafe(tail, PERSISTENT_SHELL_OUT_TAIL_CHARS);
      dropped += byteLen(tail) - byteLen(kept);
      tail = kept;
    }
    text = win.head + truncatedMarker(dropped) + tail;
  }
  atomicWrite(outPath(root, id), text);
  touchSeen(root, id);
}

/** 触 lastSeenAt（追加/心跳/收尾调用；记录缺失则静默 no-op）。 */
export function touchSeen(root: string, id: string): void {
  const record = readShellRecord(root, id);
  if (record === undefined) return;
  atomicWrite(recordPath(root, id), JSON.stringify({ ...record, lastSeenAt: nowIso() }));
}

/** 收尾：.rc 落盘（原子）+ 触 lastSeenAt。idempotent（重写同值无害）。 */
export function finalizeShell(root: string, id: string, rc: number): void {
  const dir = persistentShellDir(root);
  mkdirSync(dir, { recursive: true });
  atomicWrite(rcPath(root, id), String(rc));
  touchSeen(root, id);
}

/** 孤儿清理：lastSeenAt 超过 maxAge（缺省 7 天）的三件套整体删除，返回被
 *  清理的 id。不可解析的 lastSeenAt 按超龄处理（fail-closed——腐记录不
 *  永生）。活 shell 由心跳续命，不会被误清。 */
export function pruneStaleShells(root: string, maxAgeMs: number = PERSISTENT_SHELL_PRUNE_MS): string[] {
  const pruned: string[] = [];
  for (const record of listPersistentShells(root)) {
    const seen = Date.parse(record.lastSeenAt);
    if (Number.isFinite(seen) && Date.now() - seen <= maxAgeMs) continue;
    for (const p of [recordPath(root, record.id), outPath(root, record.id), rcPath(root, record.id)]) {
      try {
        rmSync(p, { force: true });
      } catch {
        /* 尽力清理——残留由下次清扫收 */
      }
    }
    pruned.push(record.id);
  }
  return pruned;
}

// ---------------------------------------------------------------------------
// 进程注册表 + runtime（内存 Map<id, child>；按 root 记忆化的进程级单例）
// ---------------------------------------------------------------------------

/** 三态 liveness：running（本进程或他进程拥有）/ finished（.rc 在）/ vanished
 *  （进程已消失，输出保留——.rc 缺席 + 未拥有 + lastSeenAt 超时）。 */
export type PersistentShellState = "running" | "finished" | "vanished";

/** 单条 shell 的完整状态面（shell_read / outstanding 的喂数据）。 */
export interface PersistentShellStatus {
  readonly record: PersistentShellRecord;
  readonly state: PersistentShellState;
  /** finished 时的退出码（-1 = 被信号杀死，没有干净的退出码）。 */
  readonly exitCode?: number;
  /** running 时是否由本进程注册表拥有（他进程的 shell 本进程停不了）。 */
  readonly owned: boolean;
  /** running 且本进程拥有时的 pid（渲染用；从不用于跨进程判定）。 */
  readonly pid?: number;
}

interface LiveShell {
  readonly child: ChildProcess;
  readonly record: PersistentShellRecord;
  pending: string;
  flushTimer: ReturnType<typeof setTimeout> | undefined;
  exited: boolean;
  /** close 一次性承诺（stop 的有界等待挂在这上面）。 */
  readonly closed: Promise<void>;
}

/** runtime 面：start/status/list/outstanding/stop。stop 是唯一异步（有界
 *  等待 close）；其余同步、永不抛（typed 结果）。 */
export interface PersistentShellRuntime {
  start(command: string, opts?: { readonly cwd?: string }): { readonly ok: true; readonly record: PersistentShellRecord; readonly pid: number } | { readonly ok: false; readonly error: string };
  status(id: string): PersistentShellStatus | undefined;
  list(): readonly PersistentShellStatus[];
  /** 本进程所有、仍在跑的持久 shell（outstanding-work 的 exact 面——
   *  跨进程的 shell 不归本 run 计，压缩摘要只列还挂得住恢复指针的工作）。 */
  outstanding(): readonly { readonly id: string; readonly command: string }[];
  stop(id: string): Promise<StopOutcome>;
  aliveCount(): number;
};

export type StopOutcome =
  | { readonly kind: "stopped"; readonly exitCode: number | undefined }
  | { readonly kind: "finished"; readonly exitCode: number | undefined }
  | { readonly kind: "foreign" }
  | { readonly kind: "unknown" };

// root → runtime 的进程级记忆化（sessionLeaseBoxFor 的同款纪律：同根会话
// 共享同一注册表；不同 tmpdir 互不可见——测试隔离的天然缝）。
const runtimes = new Map<string, PersistentShellRuntime>();

/** 取（或建）该工作区的持久 shell runtime。首次创建顺带跑一次孤儿清扫。 */
export function persistentShellRuntime(root: string): PersistentShellRuntime {
  const existing = runtimes.get(root);
  if (existing !== undefined) return existing;
  const runtime = createRuntime(root);
  runtimes.set(root, runtime);
  try {
    pruneStaleShells(root);
  } catch {
    /* 启动清扫尽力而为——失败不阻塞 runtime */
  }
  return runtime;
}

function createRuntime(root: string): PersistentShellRuntime {
  const registry = new Map<string, LiveShell>();
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  const armHeartbeat = (): void => {
    if (registry.size === 0) {
      if (heartbeat !== undefined) {
        clearInterval(heartbeat);
        heartbeat = undefined;
      }
      return;
    }
    if (heartbeat === undefined) {
      // 心跳只触 lastSeenAt（未拥有判定的保鲜）；unref——绝不拽住事件循环。
      heartbeat = setInterval(() => {
        for (const live of registry.values()) {
          if (!live.exited) {
            try {
              touchSeen(root, live.record.id);
            } catch {
              /* 盘坏不杀进程——心跳尽力 */
            }
          }
        }
      }, PERSISTENT_SHELL_HEARTBEAT_MS);
      heartbeat.unref?.();
    }
  };

  const flush = (live: LiveShell): void => {
    if (live.flushTimer !== undefined) {
      clearTimeout(live.flushTimer);
      live.flushTimer = undefined;
    }
    if (live.pending === "") return;
    const chunk = live.pending;
    live.pending = "";
    try {
      appendShellOutput(root, live.record.id, chunk);
    } catch {
      /* 盘满/目录消失——丢这一批，泵继续（.out 最终由 finalize 收口） */
    }
  };

  const onData = (live: LiveShell, chunk: Buffer): void => {
    live.pending += chunk.toString("utf8");
    if (live.pending.length > PENDING_FLUSH_CHARS) {
      flush(live);
      return;
    }
    if (live.flushTimer === undefined) {
      live.flushTimer = setTimeout(() => {
        live.flushTimer = undefined;
        flush(live);
      }, PERSISTENT_SHELL_FLUSH_MS);
      live.flushTimer.unref?.();
    }
  };

  const start = (
    command: string,
    opts: { readonly cwd?: string } = {},
  ): { readonly ok: true; readonly record: PersistentShellRecord; readonly pid: number } | { readonly ok: false; readonly error: string } => {
    if (process.platform === "win32") {
      return { ok: false, error: "persistent shells are POSIX-only (v1); use shell for one-shot commands" };
    }
    if (typeof command !== "string" || command.trim() === "") {
      return { ok: false, error: "command must be a non-empty string" };
    }
    // 上限检查在建档之前——拒绝不留孤儿记录。
    if (registry.size >= PERSISTENT_SHELL_MAX_ALIVE) {
      return { ok: false, error: `too many live persistent shells (${PERSISTENT_SHELL_MAX_ALIVE} cap) — stop one first` };
    }
    let record: PersistentShellRecord;
    try {
      record = createShellRecord(root, command);
    } catch (err) {
      return { ok: false, error: `cannot write the shell record: ${err instanceof Error ? err.message : String(err)}` };
    }
    let child: ChildProcess;
    try {
      // detached = 自成进程组（pgid = pid）——stop 的组击杀靠它；unref 后
      // harness 事件循环不被长任务拽住。stdin 关闭（ignore）：提示型命令
      // 立刻见 EOF 而非干等（无超时进程里挂死是永久的）。
      child = spawn("/bin/sh", ["-c", command], {
        cwd: opts.cwd ?? root,
        env: scrubChildEnv(),
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      for (const p of [recordPath(root, record.id), outPath(root, record.id)]) {
        try {
          rmSync(p, { force: true });
        } catch {
          /* best-effort */
        }
      }
      return { ok: false, error: `spawn failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    child.unref();
    let resolveClosed: () => void = () => {};
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    const live: LiveShell = { child, record, pending: "", flushTimer: undefined, exited: false, closed };
    const pid = child.pid ?? -1;
    registry.set(record.id, live);
    armHeartbeat();
    child.stdout?.on("data", (c: Buffer) => onData(live, c));
    child.stderr?.on("data", (c: Buffer) => onData(live, c));
    child.once("error", (err) => {
      // 异步 spawn 失败（如 /bin/sh 缺失）——按被杀收口，输出留错误行。
      live.exited = true;
      flush(live);
      try {
        appendShellOutput(root, record.id, `[spawn error] ${err.message}\n`);
      } catch {
        /* best-effort */
      }
      try {
        finalizeShell(root, record.id, -1);
      } catch {
        /* best-effort */
      }
      registry.delete(record.id);
      armHeartbeat();
      resolveClosed();
    });
    child.once("close", (code) => {
      live.exited = true;
      flush(live); // 收尾前把缓冲排干净——close 前数据事件必已到齐
      try {
        finalizeShell(root, record.id, code === null ? -1 : code);
      } catch {
        /* best-effort——.rc 缺席时读侧按超时兜底 */
      }
      registry.delete(record.id);
      armHeartbeat();
      resolveClosed();
    });
    return { ok: true, record, pid };
  };

  const statusOf = (record: PersistentShellRecord): PersistentShellStatus => {
    const rc = shellExitCode(root, record.id);
    if (rc !== undefined) {
      return { record, state: "finished", exitCode: rc, owned: false };
    }
    const live = registry.get(record.id);
    if (live !== undefined && !live.exited) {
      const pid = live.child.pid;
      return { record, state: "running", owned: true, ...(pid !== undefined ? { pid } : {}) };
    }
    // 未拥有 + .rc 缺席：宽限内按他进程所有（诚实的不确定窗）；超时判死。
    const seen = Date.parse(record.lastSeenAt);
    const fresh = Number.isFinite(seen) && Date.now() - seen <= PERSISTENT_SHELL_ORPHAN_GRACE_MS;
    return fresh
      ? { record, state: "running", owned: false }
      : { record, state: "vanished", owned: false };
  };

  const status = (id: string): PersistentShellStatus | undefined => {
    const record = readShellRecord(root, id);
    return record === undefined ? undefined : statusOf(record);
  };

  const stop = async (id: string): Promise<StopOutcome> => {
    const live = registry.get(id);
    if (live === undefined) {
      // 非本进程所有：绝不按盘上记录赌 pid——finished 如实报，未拥有 typed 拒。
      const record = readShellRecord(root, id);
      if (record === undefined) return { kind: "unknown" };
      const rc = shellExitCode(root, id);
      return rc !== undefined ? { kind: "finished", exitCode: rc } : { kind: "foreign" };
    }
    flush(live);
    const pid = live.child.pid;
    if (pid !== undefined) {
      // 组击杀（负 pid）——TERM 先行，2s 后 KILL 兜 TERM 免疫的漏网。
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        /* 组已不在——close 马上到 */
      }
      const esk = setTimeout(() => {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }, STOP_SIGKILL_GRACE_MS);
      esk.unref?.();
    }
    // 有界等待 close：超窗也按已停收口（信号已发，进程组必死；.rc 由 close
    // 处理器随后落盘）。
    await Promise.race([
      live.closed,
      new Promise<void>((resolve) => {
        const drop = setTimeout(resolve, STOP_CLOSE_WAIT_MS);
        drop.unref?.();
      }),
    ]);
    return { kind: "stopped", exitCode: shellExitCode(root, id) };
  };

  return {
    start,
    status,
    list: () => listPersistentShells(root).map(statusOf),
    outstanding: () =>
      [...registry.values()]
        .filter((live) => !live.exited)
        .map((live) => ({ id: live.record.id, command: live.record.command })),
    stop,
    aliveCount: () => [...registry.values()].filter((live) => !live.exited).length,
  };
}
