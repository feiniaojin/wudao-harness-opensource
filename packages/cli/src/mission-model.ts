// ω99 拆分运动 弧 B：mission 域模型外提（类型/常量/台账形状校验纯函数——
// 原 mission.ts 模块级段逐字保留；mission.ts re-export 门面保公共面）。
import { join } from "node:path";

export const MISSION_STORE_FILE = "mission.json";
// ω99-36 — the per-mission archive directory: one campaign, one immutable
// ledger file (.wudao/missions/<missionId>.json). mission.json stays but
// shrinks to the SMALL active pointer (version 2: missionId + summary — it
// points at the ledger file, it never carries history), so the historical
// overwrite churn (12 mission_starts → one surviving ledger) dies at the
// storage layer: archives are append-only archaeology, the pointer's
// overwrite is harmless by construction.
export const MISSIONS_DIR = "missions";
/** ω99-36 — filename-safety red line for archive ids (the pointer is
 *  machine-written; anything failing this is tampering → corrupt refusal).
 *  Same charset family as the bundle-name whitelist; deliberately NOT the
 *  mint pattern — hand-written test ledgers (mhand/mtest/mlegacy) must keep
 *  loading, only traversal/hidden shapes refuse. */
export const MISSION_ARCHIVE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** Per-task failure budget (gate reds + manual fails) before the task is
 *  parked as failed and disappears from the ready queue. */
export const MISSION_TASK_MAX_ATTEMPTS = 3;
export const MISSION_OBJECTIVE_MAX_CHARS = 4000;
export const MISSION_TITLE_MAX_CHARS = 400;
export const MISSION_DETAIL_MAX_CHARS = 4000;
// ω99-17 — mission-scoped typed knowledge (brief: 任务知识资产): budgets at
// memory-system scale (MEMORY_MAX_CONTENT_CHARS = 500) plus a hard ceiling
// on LIVE notes that forces merge-by-supersede over endless piling.
export const MISSION_NOTE_TITLE_MAX_CHARS = 80;
export const MISSION_NOTE_CONTENT_MAX_CHARS = 500;
export const MISSION_MAX_NOTES = 200;
/** know() listing cap: newest 40 lines, then a 「还有 N 条」 fold. */
export const MISSION_KNOW_LIST_MAX = 40;
export const MISSION_NOTE_KINDS = ["decision", "convention", "pitfall", "checklist"] as const;
export type NoteKind = (typeof MISSION_NOTE_KINDS)[number];
// ω99-18 — the bundle-name whitelist (path-safety red line): an alphanumeric
// head, then [A-Za-z0-9._-] up to 120 chars total. Rejects traversal
// (`..`-as-a-segment, `/`, `\`), hidden dirs (leading dot) and overlong
// names BEFORE any ledger write; the gate runs both at declare time (the
// controller) and in the assembly read (activeBundleSkillRoots).
export const MISSION_BUNDLE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;

/** ω99-18 — a bundle's skills root:
 *  <workspaceRoot>/.wudao/mission-bundles/<name>/skills/ (each subdirectory
 *  one skill, SKILL.md in the existing format). */
export function missionBundleSkillsRoot(workspaceRoot: string, name: string): string {
  return join(workspaceRoot, ".wudao", "mission-bundles", name, "skills");
}

/** ω99-17 — one knowledge note: a convention/decision/pitfall/checklist the
 *  mission's tasks must honor. Old notes are never deleted — supersededBy
 *  marks the replacement (append-only audit + explicit evolution semantics). */
export interface MissionNote {
  /** Controller-assigned (n1,n2,… — insertion order); models never mint ids. */
  readonly id: string;
  readonly kind: NoteKind;
  readonly title: string;
  readonly content: string;
  /** The task the note was struck under (optional provenance). */
  readonly taskRef?: string;
  /** The note that replaced this one — set once, never cleared. */
  readonly supersededBy?: string;
  readonly createdAt: string;
}

export interface MissionTask {
  /** Controller-assigned (t1,t2,… — insertion order); models never mint ids. */
  readonly id: string;
  readonly title: string;
  readonly detail?: string;
  /** All must be done before claim/nextReady selects this task. */
  readonly dependsOn: readonly string[];
  /** complete() must pass this command first (goal's runner semantics). */
  readonly gate?: { readonly command: string };
  /** ω99-249: #1 — the task's TOKEN BUDGET (positive integer, optional). The
   *  ledger-declared budget is the single truth: claiming a task that has one
   *  materializes the model-side GoalState (goal-runtime.ts) bound to this
   *  task — the budget never lives anywhere else (no dual truth). Absent =
   *  the task runs unbudgeted (no goal object, zero injection noise). */
  readonly budgetTokens?: number;
  /** ω99-17 — note ids this task pinned at plan() time; the live
   *  (non-superseded) ones are replayed verbatim at claim time. */
  readonly noteRefs?: readonly string[];
  readonly status: "todo" | "doing" | "done" | "failed";
  /** Gate-red / manual-fail count. */
  readonly attempts: number;
  /** Done-outcome summary, or the last failure reason (prefixed). */
  readonly result?: string;
}

/** ω99-16 — one ratchet entry: a command a gated completion verified (exit
 *  0) plus the task whose acceptance added it. Deduped by command string;
 *  append-only for the mission's lifetime (insertion order = run order). */
export interface RatchetEntry {
  readonly command: string;
  readonly addedByTask: string;
}

export interface MissionState {
  readonly id: string;
  readonly objective: string;
  readonly createdAt: string;
  /** ω99-36 — "stale" is the boundary-settlement terminal state: an active
   *  ALL-EMPTY mission the session ended without completing (空壳悬空) —
   *  distinct from "abandoned" (user/模型 intent) so the archaeology layer
   *  can tell a deliberate close from a dangling shell. */
  readonly status: "active" | "completed" | "abandoned" | "stale";
  /** v7 γ2（a reference harness #6162 思想）——终态成因：status 只说「成了什么态」，
   *  不说「谁/什么结束了它」。abandoned 带 user-abort（用户/模型 deliberate
   *  放弃）；stale 带 shutdown（会话边界结算=前端卸载/关窗的空壳悬空）。
   *  可选、additive——legacy 台账无此字段照常加载（无因记录降级为无
   *  detail，绝不臆造）。completed 不带（自然终态无需成因）。 */
  readonly endCause?: string;
  /** Append-only across plan() calls; never edited or removed. */
  readonly tasks: readonly MissionTask[];
  /** ω99-16 — the acceptance ratchet (absent = empty; pre-ω99-16 ledgers
   *  load clean and read as []). */
  readonly ratchet?: readonly RatchetEntry[];
  /** ω99-17 — the mission's knowledge notes (absent = empty; pre-ω99-17
   *  ledgers load clean and read as []). Same ledger, same recovery. */
  readonly notes?: readonly MissionNote[];
  /** ω99-18 — the mission's declared tool bundles (absent = empty;
   *  pre-ω99-18 ledgers load clean and read as []). Names whitelist-checked
   *  at declare time; existence verified at declare time only (a bundle dir
   *  deleted later degrades silently at boot/rescan). */
  readonly bundles?: readonly string[];
}

/** plan() input — ids and bookkeeping fields are controller-owned. */
export interface PlanTaskInput {
  readonly title: string;
  readonly detail?: string;
  readonly dependsOn?: readonly string[];
  readonly gate?: string;
  /** ω99-249: the task's token budget (positive integer, optional — the
   *  GoalState materializes at claim time when declared). */
  readonly budgetTokens?: number;
  /** ω99-17 — note ids to pin onto the task (unknown ids refuse the whole
   *  batch); the live ones replay verbatim when the task is claimed. */
  readonly notes?: readonly string[];
}

/** ω99-17 — knowAdd() input — the note id is controller-owned. */
export interface KnowAddInput {
  readonly kind: string;
  readonly title: string;
  readonly content: string;
  readonly taskRef?: string;
  readonly supersedes?: string;
}

// ---------------------------------------------------------------------------
// The store — ω99-36: per-mission archives + the small active pointer.
//   .wudao/missions/<missionId>.json  one campaign, one file: {version:1,
//                                     mission} — the SAME body shape the
//                                     single ledger always used, so the
//                                     archaeology layer needs no new parser.
//   .wudao/mission.json               version 2 active pointer:
//                                     {version:2, missionId, summary} —
//                                     small, overwrite harmless; it points,
//                                     it never carries history.
// Write protocol stays cron.json/schedules.ts's exact one (mkdir,
// write-beside, rename-over) per file; the ARCHIVE lands before the pointer
// flip so the pointer never names a file that does not exist yet. Legacy
// version-1 mission.json (the whole mission inline) reads in place — no
// destructive migration, no .bak (T1 decision); when a later save displaces
// that mission its bytes are backfilled into its archive FIRST (the pointer
// flip would otherwise orphan the v1 file's only copy).
// ---------------------------------------------------------------------------

/** The pointer file's one-glance summary (humans/runners peeking without
 *  following the pointer; objective truncated to keep the file small). */
export interface MissionPointerSummary {
  readonly id: string;
  readonly objective: string;
  readonly status: MissionState["status"];
  readonly createdAt: string;
  readonly tasksDone: number;
  readonly tasksTotal: number;
}


const MISSION_STATUSES: ReadonlySet<string> = new Set(["active", "completed", "abandoned", "stale"]);
const TASK_STATUSES: ReadonlySet<string> = new Set(["todo", "doing", "done", "failed"]);
export const NOTE_KIND_SET: ReadonlySet<string> = new Set(MISSION_NOTE_KINDS);

export function validMission(m: unknown): m is MissionState {
  if (typeof m !== "object" || m === null) return false;
  const t = m as Record<string, unknown>;
  if (typeof t.id !== "string" || t.id === "") return false;
  if (typeof t.objective !== "string" || t.objective === "") return false;
  if (typeof t.createdAt !== "string" || t.createdAt === "") return false;
  if (typeof t.status !== "string" || !MISSION_STATUSES.has(t.status)) return false;
  // v7 γ2：终态成因可缺席；在场必须是串（词表守卫在写入侧，读侧只挡畸形）。
  if (t.endCause !== undefined && typeof t.endCause !== "string") return false;
  if (!Array.isArray(t.tasks)) return false;
  const ids = new Set(t.tasks.map((x) => (typeof (x as Record<string, unknown>)?.id === "string" ? (x as Record<string, unknown>).id as string : "")));
  for (const raw of t.tasks) {
    if (typeof raw !== "object" || raw === null) return false;
    const task = raw as Record<string, unknown>;
    if (typeof task.id !== "string" || task.id === "") return false;
    if (typeof task.title !== "string" || task.title === "") return false;
    if (typeof task.status !== "string" || !TASK_STATUSES.has(task.status)) return false;
    if (typeof task.attempts !== "number" || !Number.isInteger(task.attempts) || task.attempts < 0) return false;
    if (!Array.isArray(task.dependsOn) || task.dependsOn.some((d) => typeof d !== "string")) return false;
    if (task.detail !== undefined && typeof task.detail !== "string") return false;
    if (task.result !== undefined && typeof task.result !== "string") return false;
    // ω99-249 — the optional token budget: a positive integer or absent
    // (anything else is a tampered ledger → corrupt refusal).
    if (task.budgetTokens !== undefined && (typeof task.budgetTokens !== "number" || !Number.isInteger(task.budgetTokens) || task.budgetTokens <= 0)) return false;
    // ω99-17 — pinned note references are shape-checked (write time already
    // guarantees existence; superseded notes STAY, so refs never dangle).
    if (task.noteRefs !== undefined && (!Array.isArray(task.noteRefs) || task.noteRefs.some((r) => typeof r !== "string"))) return false;
    if (task.gate !== undefined) {
      if (typeof task.gate !== "object" || task.gate === null || typeof (task.gate as Record<string, unknown>).command !== "string") return false;
    }
    // Dangling deps = a tampered ledger; the ledger is machine-written.
    if (!(task.dependsOn as string[]).every((d) => ids.has(d))) return false;
  }
  // ω99-16 — ratchet is OPTIONAL (pre-ω99-16 ledgers load clean); when
  // present it must be an array of well-formed entries.
  if (t.ratchet !== undefined) {
    if (!Array.isArray(t.ratchet)) return false;
    for (const raw of t.ratchet) {
      if (typeof raw !== "object" || raw === null) return false;
      const entry = raw as Record<string, unknown>;
      if (typeof entry.command !== "string" || entry.command === "") return false;
      if (typeof entry.addedByTask !== "string" || entry.addedByTask === "") return false;
    }
  }
  // ω99-17 — notes are OPTIONAL (pre-ω99-17 ledgers load clean); when
  // present every item must be well-formed and every supersededBy must
  // point at a known note id (the ledger is machine-written).
  if (t.notes !== undefined) {
    if (!Array.isArray(t.notes)) return false;
    const noteIds = new Set<string>();
    for (const raw of t.notes) {
      if (typeof raw !== "object" || raw === null) return false;
      const note = raw as Record<string, unknown>;
      if (typeof note.id !== "string" || note.id === "") return false;
      if (typeof note.kind !== "string" || !NOTE_KIND_SET.has(note.kind)) return false;
      if (typeof note.title !== "string" || note.title === "") return false;
      if (typeof note.content !== "string") return false;
      if (typeof note.createdAt !== "string" || note.createdAt === "") return false;
      if (note.taskRef !== undefined && typeof note.taskRef !== "string") return false;
      if (note.supersededBy !== undefined && typeof note.supersededBy !== "string") return false;
      if (noteIds.has(note.id)) return false;
      noteIds.add(note.id);
    }
    for (const raw of t.notes) {
      const supersededBy = (raw as Record<string, unknown>).supersededBy;
      if (typeof supersededBy === "string" && !noteIds.has(supersededBy)) return false;
    }
  }
  // ω99-18 — bundles are OPTIONAL (pre-ω99-18 ledgers load clean); when
  // present: string array, non-empty items, no duplicates. Shape only —
  // existence was verified at declare time (the ledger is machine-written).
  if (t.bundles !== undefined) {
    if (!Array.isArray(t.bundles) || t.bundles.some((b) => typeof b !== "string" || b === "")) return false;
    if (new Set(t.bundles).size !== t.bundles.length) return false;
  }
  return true;
}
