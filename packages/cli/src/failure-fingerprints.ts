// 永续迭代 v6 · the upstream project 借鉴弧 A（digest-the upstream project C2）——失败指纹清单：失败模式的
// 结构化记忆。the upstream project manifest.py 的 wudao 落地，语义照搬、存储不搬：
//
//   归一化 cause（绝对路径→<path>、含数字的 16+ 位标识串→<id>、数字→<n>、
//   ANSI 剥离、空白折叠、截 200 字符）→ 指纹 = sha256(subject, stage,
//   normalized)。归一化是纯函数、确定性——同一失败模式在不同时间戳/不同
//   临时目录/不同 pid 下指纹相同，**跨进程重启与全新工作目录稳定**（the upstream project
//   manifest 的硬性要求）。
//
//   事件溯源（append-only JSONL，.wudao/failure-fingerprints.jsonl，与
//   memory.jsonl / mission 台账同族的工作区级存储）：每条失败观察是一行
//   {type:"observed"}，每次「该命令又绿了 / 该任务完成了」是一行
//   {type:"resolved"}。清单从事件流 FOLD 派生——不做第二份可变状态（运行时
//   状态 ≠ 持久化状态：事件是唯一持久真相，manifest 是派生视图）。
//
//   状态机 new→persisting→fixed（the upstream project FailureManifest 三分类）：
//   - 首次 observed → new（streak 1）；
//   - 再次 observed → persisting（streak++，连续未解决的次数）；
//   - resolved 命中未结记录 → fixed（streak 清零，resolvedCount++）；
//   - fixed 后再现（回归）→ persisting（streak 重新从 1 起——历史只追加，
//     回归不改写 fixed 事实）。
//
//   为什么不用 M35 §2 泛型会话车道：指纹必须**跨会话/跨 mission** 回答
//   「这个失败模式第几次了」，会话 JSONL 随会话归档；工作区级 JSONL 与
//   mission/记忆存储同族，是同一决策（workspace 生命周期 = 产品生命周期）。
//
//   M24（缓存不变量）：本模块零模型输入字节。指纹只进 (a) 工具结果回执的
//   尾部追加（当轮后缀，无前缀代价），(b) mission status 文本（人读面）。
//   修复沉淀走 mission 知识条目——不自动钉进任务（不进认领回放），零注入
//   代价，直到模型显式引用。
//
//   wave2 接口预留（门控自改进闭环，digest C1）：`foldFailureManifest` 的
//   persisting 记录就是未来提案器的结构化失败上下文（the upstream project 正是让提案器读
//   manifest 而非散文）；`readFailureEvents` + fold 即提案器读入面。
import { createHash } from "node:crypto";
import { mkdir, appendFile, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** The manifest's workspace-relative home (beside mission.json / memory.jsonl). */
export const FAILURE_FINGERPRINTS_FILE = "failure-fingerprints.jsonl";
/** Normalized cause cap (the upstream project manifest.py:52's 200-char truncation). */
export const FP_CAUSE_MAX_CHARS = 200;
/** Raw-cause preview cap for events (bounded rows; the normalized form is the identity). */
export const FP_PREVIEW_MAX_CHARS = 160;

export function failureFingerprintPath(workspaceRoot: string): string {
  return join(workspaceRoot, ".wudao", FAILURE_FINGERPRINTS_FILE);
}

// ---------------------------------------------------------------------------
// Normalization + fingerprint (pure, deterministic).
// ---------------------------------------------------------------------------

/** Long identifier runs ([A-Za-z0-9]{16,}) that carry at least one digit —
 *  hex/base62/uuid-ish ids. Pure-alpha runs (English words like
 *  "internationalization") stay: masking them would collide distinct causes
 *  ("…failed" prose), and real ids virtually always carry a digit. */
const LONG_ID_RE = /[A-Za-z0-9]{16,}/g;
const hasDigit = (run: string): boolean => /[0-9]/.test(run);

/** Absolute paths (POSIX /…, home ~/…, Windows C:\…) → `<path>`. Relative
 *  paths stay — they are stable identities, not noise (the upstream project masks absolute
 *  paths because temp dirs differ between runs; repo-relative paths don't). */
const ABS_PATH_RE = /(?:~\/|[A-Za-z]:[\\/]|\/)[^\s"']*/g;

/** ISO timestamps collapse under the number rule anyway; listed for clarity. */
const ANY_NUMBER_RE = /-?\d+(?:\.\d+)?/g;
const ANSI_RE = /\u001b\[[0-9;]*[A-Za-z]/g;

/** Pure: normalize a raw failure cause into the fingerprint's identity text.
 *  Deterministic — no clock, no pid, no randomness; identical inputs always
 *  normalize identically, and same-shape/different-noise inputs collide BY
 *  DESIGN (that collision is the feature: "same failure mode"). */
export function normalizeFailureCause(cause: string): string {
  let text = cause.replace(ANSI_RE, "");
  text = text.replace(ABS_PATH_RE, "<path>");
  text = text.replace(LONG_ID_RE, (run) => (hasDigit(run) ? "<id>" : run));
  text = text.replace(ANY_NUMBER_RE, "<n>");
  text = text.replace(/\s+/g, " ").trim();
  return text.length <= FP_CAUSE_MAX_CHARS ? text : text.slice(0, FP_CAUSE_MAX_CHARS);
}

/** The stable failure-mode identity: sha256 over subject+stage+normalized.
 *  `subject` is the cross-mission stable task identity — the gate COMMAND
 *  when one exists (``npm test`` failing is the same failure mode in any
 *  mission), else the task title. */
export function failureFingerprint(subject: string, stage: FailureStage, normalizedCause: string): string {
  return createHash("sha256").update(`${subject}\u0000${stage}\u0000${normalizedCause}`).digest("hex");
}

// ---------------------------------------------------------------------------
// Events + the derived manifest.
// ---------------------------------------------------------------------------

/** Where the failure was observed. gate/ratchet/final-check share the gate
 *  COMMAND as their subject (a green rerun of that command resolves all
 *  three); task-fail uses the task title and resolves when the task lands
 *  done. v7 γ2: "run-end" is the sister lane「怎么结束的」——a cancelled/
 *  aborted run's terminal-cause observation (subject = the stable run
 *  identity: 计划任务 id / mission objective). It is NOT a failure: the
 *  anti-pollution rule is that run-end records never enter the failure
 *  lines/gates (mission.status renders them on their own line), and the
 *  deliberate user-abort never even enters the ledger (its why is
 *  self-evident — the user was there). */
export type FailureStage = "gate" | "ratchet" | "final-check" | "task-fail" | "run-end";

/** One JSONL line. observed = a failure seen; resolved = the owning scope
 *  passed again (green gate rerun / task done). */
export interface FailureEvent {
  readonly v: 1;
  readonly type: "observed" | "resolved";
  readonly fingerprint: string;
  /** observed: the subject identity; resolved: echoed for audit. */
  readonly subject: string;
  /** observed only. */
  readonly stage?: FailureStage;
  /** observed only: the normalized cause (resolved events never carry it). */
  readonly normalized?: string;
  readonly at: string;
  readonly missionId?: string;
  readonly taskId?: string;
  /** observed only: bounded raw-cause preview (human reading the file). */
  readonly preview?: string;
}

/** One failure mode's lifecycle over the whole event stream. */
export interface FailureRecord {
  readonly fingerprint: string;
  readonly subject: string;
  readonly stage: FailureStage;
  readonly normalized: string;
  /** Total observations ever (across fixes). */
  readonly count: number;
  /** Consecutive unresolved observations (0 while fixed). */
  readonly streak: number;
  readonly firstSeen: string;
  readonly lastSeen: string;
  readonly lastMissionId?: string;
  readonly lastTaskId?: string;
  readonly status: "new" | "persisting" | "fixed";
  /** How many times this mode was observed-then-resolved (fix count). */
  readonly resolvedCount: number;
  readonly preview?: string;
}

/** True while the record still names an UNRESOLVED failure mode. */
export function isOpenFailure(r: FailureRecord): boolean {
  return r.status === "new" || r.status === "persisting";
}

/** Pure: fold the event stream (file order) into the manifest. Unknown-
 *  fingerprint resolved events are ignored (defensive: a tampered/partial
 *  file never manufactures records). */
export function foldFailureManifest(events: readonly FailureEvent[]): readonly FailureRecord[] {
  const byFp = new Map<string, FailureRecord>();
  for (const e of events) {
    if (e.type === "observed") {
      if (e.stage === undefined || e.normalized === undefined) continue; // malformed row — skip
      const prev = byFp.get(e.fingerprint);
      byFp.set(e.fingerprint, {
        fingerprint: e.fingerprint,
        subject: e.subject,
        stage: e.stage,
        normalized: e.normalized,
        count: (prev?.count ?? 0) + 1,
        streak: (prev?.streak ?? 0) + 1,
        firstSeen: prev?.firstSeen ?? e.at,
        lastSeen: e.at,
        ...(e.missionId !== undefined ? { lastMissionId: e.missionId } : prev?.lastMissionId !== undefined ? { lastMissionId: prev.lastMissionId } : {}),
        ...(e.taskId !== undefined ? { lastTaskId: e.taskId } : prev?.lastTaskId !== undefined ? { lastTaskId: prev.lastTaskId } : {}),
        status: prev === undefined ? "new" : "persisting",
        resolvedCount: prev?.resolvedCount ?? 0,
        ...(e.preview !== undefined ? { preview: e.preview } : prev?.preview !== undefined ? { preview: prev.preview } : {}),
      });
    } else {
      const prev = byFp.get(e.fingerprint);
      if (prev === undefined || !isOpenFailure(prev)) continue;
      byFp.set(e.fingerprint, { ...prev, status: "fixed", streak: 0, resolvedCount: prev.resolvedCount + 1 });
    }
  }
  return [...byFp.values()];
}

/** Build one observed event (the record's badge inputs come from folding it). */
export function buildObservedEvent(input: {
  readonly subject: string;
  readonly stage: FailureStage;
  readonly cause: string;
  readonly at: string;
  readonly missionId?: string;
  readonly taskId?: string;
}): FailureEvent {
  const normalized = normalizeFailureCause(input.cause);
  return {
    v: 1,
    type: "observed",
    fingerprint: failureFingerprint(input.subject, input.stage, normalized),
    subject: input.subject,
    stage: input.stage,
    normalized,
    at: input.at,
    ...(input.missionId !== undefined ? { missionId: input.missionId } : {}),
    ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
    preview: input.cause.slice(0, FP_PREVIEW_MAX_CHARS),
  };
}

// ---------------------------------------------------------------------------
// JSONL IO (tolerant read, append-only write — the memory.jsonl discipline).
// ---------------------------------------------------------------------------

function parseEvent(raw: unknown): FailureEvent | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (r.v !== 1) return undefined;
  if (r.type !== "observed" && r.type !== "resolved") return undefined;
  if (typeof r.fingerprint !== "string" || r.fingerprint === "" || typeof r.subject !== "string" || typeof r.at !== "string") return undefined;
  if (r.type === "observed" && (typeof r.stage !== "string" || typeof r.normalized !== "string")) return undefined;
  return {
    v: 1,
    type: r.type,
    fingerprint: r.fingerprint,
    subject: r.subject,
    ...(r.stage !== undefined ? { stage: r.stage as FailureStage } : {}),
    ...(r.normalized !== undefined ? { normalized: r.normalized } : {}),
    at: r.at,
    ...(r.missionId !== undefined && typeof r.missionId === "string" ? { missionId: r.missionId } : {}),
    ...(r.taskId !== undefined && typeof r.taskId === "string" ? { taskId: r.taskId } : {}),
    ...(r.preview !== undefined && typeof r.preview === "string" ? { preview: r.preview } : {}),
  } as FailureEvent;
}

/** Tolerant read: absent/unreadable file → [] (a broken ledger never breaks
 *  the mission op — the fingerprint face degrades, the failure path itself
 *  stays exactly as it was); corrupt lines skip, never abort. */
export async function readFailureEvents(path: string): Promise<readonly FailureEvent[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return [];
  }
  const out: FailureEvent[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      const parsed = parseEvent(JSON.parse(trimmed));
      if (parsed !== undefined) out.push(parsed);
    } catch {
      // skip a corrupt line rather than aborting the manifest read
    }
  }
  return out;
}

/** Append one event (mkdir-on-demand). Callers wrap failures per the
 *  fire-and-forget law — an unwritable fingerprint ledger costs ONE stderr
 *  line and never fails the mission op it rode. */
export async function appendFailureEvent(path: string, event: FailureEvent): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(event)}\n`, "utf8");
}

// ---------------------------------------------------------------------------
// User-facing derivations (pure).
// ---------------------------------------------------------------------------

/** The receipt badge for a freshly observed failure: empty on first sight
 *  (no noise),「第 N 次出现」 from the second on, with the honest「仍未修复」
 *  marker while persisting (post-fix regressions say 再现 instead). v7 γ2:
 *  the run-end lane says「该结束方式」——终态成因不是失败，名词必须分家
 *  （防污染的词面守卫）。 */
export function occurrenceBadge(record: FailureRecord): string {
  if (record.count < 2) return "";
  const noun = record.stage === "run-end" ? "该结束方式" : "该失败模式";
  const again = record.resolvedCount > 0 && record.status !== "fixed" ? "（曾修复后再现）" : "";
  return `〔${noun}第 ${record.count} 次出现${record.status === "fixed" ? "" : again === "" ? "，仍未修复" : again}〕`;
}

/** The fix-knowledge note for a resolved open record (mission_know deposit,
 *  kind pitfall — 「曾修好」任务知识资产, digest C2 超越点②). The 模式 tag
 *  is over (subject, normalized) — deliberately NOT the stage-sensitive
 *  fingerprint — so a mode fixed at gate and the SAME mode re-fixed at
 *  ratchet deposit ONE note, and a re-fail/re-fix cycle never mints a
 *  second note for the same mode. */
export function fixedNoteContent(record: FailureRecord): { readonly kind: "pitfall"; readonly title: string; readonly content: string; readonly modeTag: string } {
  const clip = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);
  const subject = clip(record.subject, 60);
  const normalized = clip(record.normalized, 180);
  const tag = `模式 ${createHash("sha256").update(`${record.subject} ${record.normalized}`).digest("hex").slice(0, 8)}`;
  return {
    kind: "pitfall",
    title: `已修复的失败模式：${subject}`,
    content: `验收「${subject}」曾以同一方式失败 ${record.count} 次后修复（${normalized}）。若再现，优先排查该模式而非从头定位。${tag}`,
    modeTag: tag,
  };
}
