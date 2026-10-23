// Workflow journal (JSONL) — the authoritative record a workflow run replays
// from. One file per run at .wudao/workflows/<runId>.jsonl.
//
// Two record families coexist:
//  - M22 step records (`step-started`/`step-finished`, keyed by step id) —
//    still written by the legacy JSON runner.
//  - M29 content-addressed task records (`task-*`, keyed by
//    sha256(prompt + canonical opts), ordered by the engine's call counter
//    `seq`). Entries append in COMPLETION order (parallel!); `loadJournal`
//    re-sorts them by `seq` so replay aligns with call order. A key mismatch
//    on resume = the script was edited → the caller truncates from the edit
//    point (see truncateTaskJournal), which keeps the untouched prefix
//    cacheable — both the provider prefix cache and the already-run steps.
import { appendFile, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { TaskOptions, TaskCost, VerifyReceipt, FailureCategory } from "./vm.js";

export type StepFinishedRecord = {
  readonly type: "step-finished";
  readonly id: string;
  readonly ok: boolean;
  readonly finalText: string;
  readonly toolsUsed: readonly string[];
  readonly endedAt: string;
};

/** One completed (ok) task — the replayable cache unit (M29). */
export type TaskJournalEntry = {
  readonly type: "task-finished";
  /** Engine call counter (call order, NOT completion order). */
  readonly seq: number;
  readonly key: string;
  readonly prompt: string;
  readonly ok: boolean;
  readonly text: string;
  /** Validated structured output when the task had a responseSchema. */
  readonly data?: unknown;
  readonly toolsUsed: readonly string[];
  readonly cost: TaskCost;
  readonly verify?: readonly VerifyReceipt[];
  readonly endedAt: string;
};

/** M11 #2 — one completed run() command (the journaled effect unit). */
export type CmdJournalEntry = {
  readonly type: "cmd-finished";
  /** Shared seq space with task calls (call order). */
  readonly seq: number;
  readonly key: string;
  readonly cmd: string;
  readonly args: readonly string[];
  readonly code: number | undefined;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly spawnError?: string;
  readonly endedAt: string;
};

export type JournalRecord =
  | { readonly type: "run-started"; readonly runId: string; readonly workflow: string; readonly startedAt: string; readonly engine?: "js" | "json-adapter" | "mea"; readonly scriptHash?: string; readonly argsHash?: string; readonly allowHash?: string }
  | CmdJournalEntry
  | { readonly type: "cmd-replayed"; readonly seq: number; readonly key: string; readonly cmd: string }
  | { readonly type: "step-started"; readonly id: string }
  | StepFinishedRecord
  | { readonly type: "task-started"; readonly seq: number; readonly key: string; readonly label?: string }
  | TaskJournalEntry
  | { readonly type: "task-failed"; readonly seq: number; readonly key: string; readonly label?: string; readonly category: FailureCategory; readonly message: string; readonly endedAt: string }
  | { readonly type: "task-replayed"; readonly seq: number; readonly key: string; readonly label?: string }
  | { readonly type: "log"; readonly message: string }
  | { readonly type: "run-finished"; readonly ok: boolean; readonly failure?: { readonly category: string; readonly message: string } };

// wf-<compact UTC timestamp>-<rand>: sortable by run time, unique per run.
export function newRunId(now: Date = new Date()): string {
  const ts = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const rand = randomUUID().replace(/-/g, "").slice(0, 8);
  return `wf-${ts}-${rand}`;
}

export function journalFilePath(workspaceRoot: string, runId: string): string {
  return join(workspaceRoot, ".wudao", "workflows", `${runId}.jsonl`);
}

export interface JournalWriter {
  readonly path: string;
  append(record: JournalRecord): Promise<void>;
}

// Open (lazily create) a journal for appending. The directory is created on
// the first append so merely resolving a path never litters the workspace.
export function openJournal(path: string): JournalWriter {
  return {
    path,
    async append(record: JournalRecord): Promise<void> {
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, JSON.stringify(record) + "\n", "utf8");
    },
  };
}

export interface JournalLoadResult {
  readonly records: readonly JournalRecord[];
  // Steps with a `step-finished ok` record, keyed by step id (resume set).
  readonly finishedOk: ReadonlyMap<string, StepFinishedRecord>;
  /** M29: ok task entries re-sorted by call order (`seq`), the replay list. */
  readonly tasks: readonly TaskJournalEntry[];
  /** M11 #2: completed run() commands re-sorted by `seq` (cmd replay list). */
  readonly cmds: readonly CmdJournalEntry[];
  /** 133 #3（a reference harness journal 身份模型）：首条携带 scriptHash+argsHash 的
   *  run-started——同身份 resume 下的键漂移=纯度违例（大声失败），异身份
   *  =脚本/参数被编辑（既有截断语义）。旧日志无此字段 → undefined（回落
   *  旧行为，fail-open 到 legacy）。 */
  readonly identity: { readonly scriptHash: string; readonly argsHash: string; readonly allowHash?: string } | undefined;
}

// Load a journal for replay. A missing file is NOT an error here — an empty
// result means "nothing completed"; callers decide whether that is fatal
// (e.g. --resume of an unknown runId).
export function loadJournal(path: string): JournalLoadResult {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { records: [], finishedOk: new Map(), tasks: [], cmds: [], identity: undefined };
  }
  const records: JournalRecord[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue; // crash mid-write → skip the partial line
    try {
      records.push(JSON.parse(trimmed) as JournalRecord);
    } catch {
      // A corrupt line never kills the run: resume works up to the last
      // well-formed record.
    }
  }
  let identity: JournalLoadResult["identity"] = undefined;
  for (const record of records) {
    if (record.type !== "run-started") continue;
    if (typeof record.scriptHash === "string" && typeof record.argsHash === "string") {
      identity = {
        scriptHash: record.scriptHash,
        argsHash: record.argsHash,
        // T007 P1：旧日志无 allowHash → 缺席（与新身份的串不等 → 编辑语义
        // 重跑，正确——授予面变了）。
        ...(typeof record.allowHash === "string" ? { allowHash: record.allowHash } : {}),
      };
      break; // the FIRST identity-bearing run-started is the run's origin
    }
  }
  const finishedOk = new Map<string, StepFinishedRecord>();
  for (const record of records) {
    if (record.type === "step-finished" && record.ok) finishedOk.set(record.id, record);
  }
  // seq re-sort: journal appends in completion order (parallel), replay walks
  // in call order. Stable sort keeps file order among equal seqs (old
  // seq-less entries degrade to 0).
  const tasks = records
    .filter((r): r is TaskJournalEntry => r.type === "task-finished" && r.ok)
    .map((r, fileIndex) => ({ entry: r, fileIndex }))
    .sort((a, b) => (a.entry.seq ?? 0) - (b.entry.seq ?? 0) || a.fileIndex - b.fileIndex)
    .map((x) => x.entry);
  // M11 #2: cmd entries share the seq ordering discipline.
  const cmds = records
    .filter((r): r is CmdJournalEntry => r.type === "cmd-finished")
    .map((r, fileIndex) => ({ entry: r, fileIndex }))
    .sort((a, b) => (a.entry.seq ?? 0) - (b.entry.seq ?? 0) || a.fileIndex - b.fileIndex)
    .map((x) => x.entry);
  return { records, finishedOk, tasks, cmds, identity };
}

// ---------------------------------------------------------------------------
// Content-addressed task keys
// ---------------------------------------------------------------------------

/** Recursively key-sorted JSON of the options that define the task's identity.
 *  Display-only fields (label) are excluded — renaming a label never forks a
 *  journal (CCB journal.ts canonical params). */
export function canonicalTaskOptions(opts: TaskOptions | undefined): string {
  const { label: _label, ...keyed } = opts ?? {};
  const sortValue = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sortValue);
    if (typeof value === "object" && value !== null) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(value as Record<string, unknown>).sort()) {
        sorted[k] = sortValue((value as Record<string, unknown>)[k]);
      }
      return sorted;
    }
    return value;
  };
  return JSON.stringify(sortValue(keyed));
}

/** key = sha256(prompt + "\n" + canonicalOpts). */
export function taskKey(prompt: string, opts: TaskOptions | undefined): string {
  return createHash("sha256").update(`${prompt}\n${canonicalTaskOptions(opts)}`).digest("hex");
}

/** T006 F3：身份哈希的参数预校验——JSON.stringify 的坑（NaN/Infinity→null、
 *  undefined 字段/Symbol/函数静默丢弃、BigInt 裸抛 TypeError）会造成**静默
 *  身份碰撞**（语义不同的 args 同哈希 → 纯度误武装/误解除）。这里对不可
 *  JSON 安全的值打类型化错误点名路径，绝不让碰撞溜进哈希。CLI 的 --args
 *  走 JSON.parse 天然安全；此守卫面向程序化调用方（测试/embedder）。 */
export class WorkflowIdentityArgsError extends Error {
  constructor(readonly path: string, readonly problem: string) {
    super(`workflowIdentity: args at ${path} ${problem} — JSON-unsafe values silently collide in the identity hash; convert to strings/numbers first`);
    this.name = "WorkflowIdentityArgsError";
  }
}

function assertJsonSafeArgs(value: unknown, path: string): void {
  if (value === null) return;
  switch (typeof value) {
    case "string":
    case "boolean":
      return;
    case "number":
      if (!Number.isFinite(value)) throw new WorkflowIdentityArgsError(path, `is ${String(value)} (serializes to null — collides with real null)`);
      return;
    case "undefined":
      throw new WorkflowIdentityArgsError(path, "is undefined (the field silently disappears — collides with absence)");
    case "bigint":
    case "symbol":
    case "function":
      throw new WorkflowIdentityArgsError(path, `is ${typeof value} (not JSON-representable)`);
    case "object": {
      if (Array.isArray(value)) {
        value.forEach((v, i) => assertJsonSafeArgs(v, `${path}[${i}]`));
        return;
      }
      for (const k of Object.keys(value as Record<string, unknown>)) {
        assertJsonSafeArgs((value as Record<string, unknown>)[k], `${path}.${k}`);
      }
      return;
    }
    default:
      return;
  }
}

/** M11 #2 — run() 命令的内容寻址键（c: 前缀隔离与 taskKey 的命名空间）。 */
export function cmdKey(cmd: string, args: readonly string[] | undefined, granted?: boolean): string {
  // T007 P1 补全：授予位进键——run() 的**结果**取决于 (cmd, args, 是否放行)，
  // 三个都要进内容寻址（修前授予态不进键：首跑拒绝落账后，resume 授予了
  // 命令仍重放命中旧 spawnError 拒绝）。授予变化同时改变 allowHash →
  // purity 不武装 → 编辑语义截断重跑，正好。
  return "c:" + createHash("sha256").update(cmd + "\n" + JSON.stringify([...(args ?? [])]) + "\n" + (granted === true ? "g" : "d")).digest("hex");
}

/** 133 #3（a reference harness journal 身份模型）— 运行身份：脚本字节 + 参数规范形的
 *  双哈希。同身份 resume 下任务键漂移 = 纯度违例（脚本在绊线之外引入了
 *  非确定性——读文件/网络/全局态），engine 大声失败而非静默重跑；异身份
 *  = 脚本或参数被编辑，走既有截断语义。args 缺省以 "undefined" 哨兵入
 *  哈希（与 undefined !== {} 的任务键语义一致）。T006 F3：不可 JSON 安全
 *  的 args 值打类型化错误（防静默碰撞）。 */
export function workflowIdentity(scriptSource: string, args: unknown, allowCmd?: readonly string[]): { scriptHash: string; argsHash: string; allowHash: string } {
  const sortValue = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sortValue);
    if (typeof value === "object" && value !== null) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(value as Record<string, unknown>).sort()) {
        sorted[k] = sortValue((value as Record<string, unknown>)[k]);
      }
      return sorted;
    }
    return value;
  };
  if (args !== undefined) assertJsonSafeArgs(args, "args");
  const argsCanonical = args === undefined ? "undefined" : JSON.stringify(sortValue(args));
  // T007 P1：命令授予进身份——策略变了=运行的世界变了（编辑语义：截断重
  // 跑），重放不再命中"旧拒绝/旧成功"（修前授予状态不进身份，开发者加
  // --allow-cmd 重跑却拿回旧的 spawnError 拒绝）。
  const grantedCanonical = [...(allowCmd ?? [])].sort().join("\n");
  return {
    scriptHash: createHash("sha256").update(scriptSource, "utf8").digest("hex"),
    argsHash: createHash("sha256").update(argsCanonical, "utf8").digest("hex"),
    allowHash: createHash("sha256").update(grantedCanonical, "utf8").digest("hex"),
  };
}

/**
 * Edit-point truncation: drop every task record whose seq is not in `keepSeqs`
 * (task-started/task-finished/task-failed/task-replayed alike). Run markers,
 * log lines and legacy step records stay. Atomic rewrite (tmp + rename) — this
 * is the ONLY operation that ever shrinks a journal, and it only removes
 * entries a resume just proved divergent.
 */
export async function truncateTaskJournal(path: string, keepSeqs: ReadonlySet<number>): Promise<void> {
  if (!existsSync(path)) return;
  const lines = readFileSync(path, "utf8").split("\n");
  const kept: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let record: JournalRecord | undefined;
    try {
      record = JSON.parse(trimmed) as JournalRecord;
    } catch {
      continue; // corrupt line: already dead weight, drop it
    }
    // T007 P2：cmd 记录同族截断——异身份编辑点的 cmd-finished/cmd-replayed
    // 若不随 keepSeqs 丢弃会随每次编辑重试累积（同 seq 多条，journal 线性
    // 膨胀 + 重放走查噪声）。
    const isSeqRecord =
      record.type === "task-started" || record.type === "task-finished" ||
      record.type === "task-failed" || record.type === "task-replayed" ||
      record.type === "cmd-finished" || record.type === "cmd-replayed";
    const seq = (record as { seq?: number }).seq;
    if (isSeqRecord && seq !== undefined && !keepSeqs.has(seq)) continue;
    kept.push(trimmed);
  }
  const tmp = `${path}.truncating`;
  await writeFile(tmp, kept.length > 0 ? kept.join("\n") + "\n" : "", "utf8");
  await rename(tmp, path);
}

// ---------------------------------------------------------------------------
// state.json — terminal run snapshots for `workflow list/status`
// ---------------------------------------------------------------------------

export interface WorkflowRunState {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly workflow: string;
  readonly status: "completed" | "failed" | "aborted";
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly tasksTotal: number;
  readonly tasksOk: number;
  readonly tasksReplayed: number;
  readonly cost: TaskCost;
  readonly failure?: { readonly category: string; readonly message: string };
}

export function workflowStatePath(workspaceRoot: string, runId: string): string {
  return join(workspaceRoot, ".wudao", "workflows", `${runId}.state.json`);
}

/** Atomic terminal-state write (tmp + rename), mirroring the journal dir. */
export async function writeWorkflowState(workspaceRoot: string, state: WorkflowRunState): Promise<void> {
  const path = workflowStatePath(workspaceRoot, state.runId);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(state) + "\n", "utf8");
  await rename(tmp, path);
}

/** Tolerant read: missing or corrupt → undefined (a bad state.json never
 *  breaks listing; the journal is still the truth for replay). */
export function readWorkflowState(path: string): WorkflowRunState | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as WorkflowRunState;
    if (typeof parsed !== "object" || parsed === null || typeof parsed.runId !== "string") return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/** All run states, newest runId first (runIds embed a sortable UTC stamp). */
export function listWorkflowStates(workspaceRoot: string): readonly WorkflowRunState[] {
  const dir = join(workspaceRoot, ".wudao", "workflows");
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }
  const states = files
    .filter((f) => f.endsWith(".state.json"))
    .map((f) => readWorkflowState(join(dir, f)))
    .filter((s): s is WorkflowRunState => s !== undefined);
  return states.sort((a, b) => (a.runId < b.runId ? 1 : a.runId > b.runId ? -1 : 0));
}

/** Keep at most `keep` runs (default 50). Orphan journals (no state.json) are
 *  pruned first; then the oldest complete runs go (journal + state together).
 *  Runs only AFTER a new state lands, so the just-finished run is always the
 *  newest and never swept. */
export async function gcWorkflowRuns(workspaceRoot: string, keep = 50): Promise<void> {
  const dir = join(workspaceRoot, ".wudao", "workflows");
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return;
  }
  const runIds = new Set<string>();
  for (const f of files) {
    const runId = f.replace(/\.(jsonl|state\.json|state\.json\.tmp)$/, "");
    if (runId !== f) runIds.add(runId);
  }
  const hasState = (runId: string): boolean => existsSync(workflowStatePath(workspaceRoot, runId));
  const orphans = [...runIds].filter((id) => !hasState(id)).sort(); // oldest stamps first
  for (const orphan of orphans) {
    await rm(join(dir, `${orphan}.jsonl`), { force: true });
    runIds.delete(orphan);
  }
  const complete = [...runIds].sort(); // ascending: oldest first
  if (complete.length <= keep) return;
  for (const runId of complete.slice(0, complete.length - keep)) {
    await rm(join(dir, `${runId}.jsonl`), { force: true });
    await rm(workflowStatePath(workspaceRoot, runId), { force: true });
  }
}
