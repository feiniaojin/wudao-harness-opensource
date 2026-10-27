// ω99-242: #2 — 中断任务自动续跑的服务面协调器（重启不丢托付）。北极星=
// 托付闭环：挂机长任务经得起重启——夜里托付的活，重启后自己验证着续跑，
// 早上是结果不是一排 todo。参考 openwork/apps/server/src/task-recovery.ts
// 的判定纪律（观察-分类-认领-限流 + graceful shutdown checkpoint + 丢 ack
// 永不重试），落在我方的持久资产上（session JSONL 半轮证据 / mission DAG
// / 跨进程会话租约）。本包不知 CLI：恢复注入走下方 RecoveryPort，由 cli
// 侧装配（resume + verify-first submit，§三模板在 cli 包）。
//
// §二设计不变量的落点（逐条）：
//  1. journal = append-only JSONL（<workspaceRoot>/.wudao/recovery.jsonl，
//     单文件协调器日志，绝不进各 session JSONL）；
//  2. 认领先落盘再 admission；claim 过但无 settle 的条目重启后归 blocked
//     交用户，永不二次自动 admission（classifyRecovery 规则 1）；
//  3. 关机 checkpoint：引擎被杀前冻结正在半轮的会话（stop()，shutdown 意
//     图不被进程被杀产生的 idle/abort 抹掉）；
//  4. 观察分类四态 terminal/blocked/active/unfinished；idle 本身不是中断
//     的证据（要求同一未完成轮，或我们自己的 checkpoint）；
//  5. verify-first 恢复 prompt 由 port.admit 注入（模板在 cli，逐字钉）；
//  6. 限流：并发恢复 ≤ RECOVERY_CONCURRENCY（2）、启动间隔 ≥
//     RECOVERY_INTERVAL_MS（2s）、大积压轮转公平；
//  7. 用户手工输入作废该会话的恢复（noteUserInput；权限回复走
//     answerPermission——server 的 submit op 才挂这个 seam，例外成立）；
//  8. 恢复 admission 走正常权限管线（port.admit = resume + submit，cli
//     侧零旁路——本协调器不做任何权限判断）；
//  9. 恢复顺序沿 mission DAG 依赖拓扑渐进拉起（dagRank 升序，非轮询序）；
// 10. M24 声明：恢复注入发生在 resume 边界=冷转预期（cold turn expected），
//     代码注释（本文件 + cli/recovery-admission.ts）+ 报告双声明。
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

/** ω99-242 — the admission start interval (invariant 6: ≥2s). */
export const RECOVERY_INTERVAL_MS = 2_000;
/** ω99-242 — the in-flight recovery ceiling (invariant 6: ≤2). */
export const RECOVERY_CONCURRENCY = 2;
/** ω99-242 — backlogs at or below this size are observed in full each tick;
 *  larger ones rotate two per tick so observation stays bounded and fair. */
export const RECOVERY_ROTATION_BOUND = 4;

// ---------------------------------------------------------------------------
// The journal (invariant 1: append-only JSONL, one coordinator file)
// ---------------------------------------------------------------------------

/** One journal line. `at` is the coordinator clock (ms). */
export type RecoveryJournalEntry =
  | { readonly type: "admit"; readonly sessionId: string; readonly at: number; readonly user?: boolean }
  | { readonly type: "checkpoint"; readonly sessionId: string; readonly at: number }
  | { readonly type: "claim"; readonly sessionId: string; readonly at: number }
  | { readonly type: "settle"; readonly sessionId: string; readonly at: number; readonly verifiedDone: number; readonly remaining: number }
  | { readonly type: "cancel"; readonly sessionId: string; readonly at: number; readonly reason: string };

/** The per-session fold of the journal (file order wins; see foldJournal). */
export interface FoldSessionState {
  readonly sessionId: string;
  /** The last admit/checkpoint/claim/settle still stands (no later cancel). */
  tracked: boolean;
  /** A shutdown checkpoint stands (the freeze intent is unconsumed). */
  checkpointed: boolean;
  /** A recovery claim stands without its settle — the lost-ack marker. */
  claimPending: boolean;
  /** Counts carried by the last settle (the web's X/Y source). */
  verifiedDone?: number;
  remaining?: number;
  lastAt: number;
}

export interface RecoveryJournalFold {
  readonly sessions: ReadonlyMap<string, FoldSessionState>;
  /** Lines that yielded no entry — unparseable, empty, or ill-shaped. */
  readonly skippedLines: number;
}

const ENTRY_TYPES: ReadonlySet<string> = new Set(["admit", "checkpoint", "claim", "settle", "cancel"]);

/** Shape gate for one parsed line — the journal is machine-written; anything
 *  else is a skipped line, never a crash (R1's honest-skip law). */
function validEntry(v: unknown): RecoveryJournalEntry | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const e = v as Record<string, unknown>;
  if (typeof e.type !== "string" || !ENTRY_TYPES.has(e.type)) return undefined;
  if (typeof e.sessionId !== "string" || e.sessionId === "") return undefined;
  if (typeof e.at !== "number" || !Number.isFinite(e.at)) return undefined;
  switch (e.type) {
    case "admit":
      if (e.user !== undefined && typeof e.user !== "boolean") return undefined;
      break;
    case "settle":
      if (typeof e.verifiedDone !== "number" || !Number.isInteger(e.verifiedDone) || e.verifiedDone < 0) return undefined;
      if (typeof e.remaining !== "number" || !Number.isInteger(e.remaining) || e.remaining < 0) return undefined;
      break;
    case "cancel":
      if (typeof e.reason !== "string" || e.reason === "") return undefined;
      break;
    default:
      break;
  }
  return e as unknown as RecoveryJournalEntry;
}

/** Fold journal lines (file order) into per-session state. Pure: same lines →
 *  same fold. Semantics per entry type:
 *  - admit — tracking intent (a run admission happened; `user` marks a manual
 *    one, which CONSUMES a standing checkpoint: the user's takeover supersedes
 *    the shutdown freeze);
 *  - checkpoint — the graceful-shutdown freeze stands;
 *  - claim — a recovery claim stands, superseding any checkpoint;
 *  - settle — the admission ACK: clears claim/checkpoint, keeps tracking,
 *    carries the reconciliation counts;
 *  - cancel — intent withdrawn (terminal / user-input / admission-failed):
 *    untracks until a LATER admit re-tracks (file order decides). */
export function foldRecoveryLines(lines: readonly string[]): RecoveryJournalFold {
  const sessions = new Map<string, FoldSessionState>();
  let skippedLines = 0;
  for (const raw of lines) {
    if (raw.trim() === "") {
      skippedLines += 1; // honest count: the line yielded no entry
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      skippedLines += 1;
      continue;
    }
    const entry = validEntry(parsed);
    if (entry === undefined) {
      skippedLines += 1;
      continue;
    }
    const s = sessions.get(entry.sessionId) ?? {
      sessionId: entry.sessionId, tracked: false, checkpointed: false, claimPending: false, lastAt: 0,
    };
    switch (entry.type) {
      case "admit":
        s.tracked = true;
        if (entry.user === true) s.checkpointed = false;
        break;
      case "checkpoint":
        s.tracked = true;
        s.checkpointed = true;
        break;
      case "claim":
        s.tracked = true;
        s.claimPending = true;
        s.checkpointed = false;
        break;
      case "settle":
        s.tracked = true;
        s.claimPending = false;
        s.checkpointed = false;
        s.verifiedDone = entry.verifiedDone;
        s.remaining = entry.remaining;
        break;
      case "cancel":
        s.tracked = false;
        s.checkpointed = false;
        s.claimPending = false;
        break;
    }
    s.lastAt = entry.at;
    sessions.set(entry.sessionId, s);
  }
  return { sessions, skippedLines };
}

export interface RecoveryJournal {
  readonly path: string;
  append(entry: RecoveryJournalEntry): Promise<void>;
  fold(): Promise<RecoveryJournalFold>;
}

/** Open (or create) the coordinator journal at `path`. Appends only — the
 *  file's earlier bytes are never rewritten (append-only law). A missing
 *  directory is created on first append; a missing/unreadable file folds to
 *  the empty state (nothing to recover — an honest zero, not an error). */
export function createRecoveryJournal(path: string): RecoveryJournal {
  let queue: Promise<void> = Promise.resolve();
  const append = (entry: RecoveryJournalEntry): Promise<void> => {
    // Serialized: the claim→settle (or cancel) ordering of one recovery must
    // land in the order it happened.
    queue = queue.catch(() => {}).then(async () => {
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, `${JSON.stringify(entry)}\n`, "utf8");
    });
    return queue;
  };
  return {
    path,
    append,
    fold: async () => {
      let text: string;
      try {
        text = await readFile(path, "utf8");
      } catch {
        return { sessions: new Map<string, FoldSessionState>(), skippedLines: 0 };
      }
      return foldRecoveryLines(text.split("\n"));
    },
  };
}

// ---------------------------------------------------------------------------
// The classifier (invariant 4: four states; idle is not evidence)
// ---------------------------------------------------------------------------

/** One observation of a candidate session — the port's evidence bundle. */
export interface RecoveryObservation {
  /** Another LIVE process holds the session's run lease → active (observe
   *  only, never re-send into a live engine). */
  readonly leaseHeldByOther: boolean;
  /** A permission ask is pending on the session → blocked (may unlock via a
   *  permission reply — invariant 7's exception). ω99-248: #8 — the evidence
   *  is now persistent for non-current sessions (the session's own
   *  permission_ask record) — the verdict survives restarts. */
  readonly permissionPending: boolean;
  /** The persisted pending ask's evidence (RECORD-sourced only: a
   *  cross-restart waiting-for-human marker for the web's morning line).
   *  Absent when the session is not record-blocked. Evidence, never
   *  authorization: nothing auto-allows off it. */
  readonly pendingAsk?: {
    readonly toolName: string;
    readonly summary: string;
    readonly question: string;
  };
  /** A delegated child task is unresolved (父等子) → blocked (the parent is
   *  not independently recovered). */
  readonly childPending: boolean;
  /** The same unfinished turn stands in the session record (half-turn
   *  evidence: orphaned tool calls, or a trailing user turn with no reply). */
  readonly turnOpen: boolean;
  /** The mission ledger is terminal (completed/abandoned/stale) → terminal. */
  readonly missionTerminal: boolean;
  /** The mission DAG topological rank of the session's bound task
   *  (Number.POSITIVE_INFINITY = mission-unbound). */
  readonly dagRank: number;
}

export interface RecoveryClassification {
  readonly state: "terminal" | "blocked" | "active" | "unfinished";
  readonly recoverable: boolean;
}

/** Classify one observation. Rule order is the judgment discipline:
 *  1. a standing claim without settle (lost ack) → blocked, never re-admitted
 *     — even across restarts (invariant 2; trumps every other signal);
 *  2. another live process owns the session → active (observe only);
 *  3. the mission ledger is terminal → terminal (untouched);
 *  4. permission pending / delegated child unresolved → blocked;
 *  5. our own shutdown checkpoint stands, or the same turn is open →
 *     unfinished (recoverable) — idle alone is NOT evidence (negative pin);
 *  6. otherwise terminal. */
export function classifyRecovery(
  observation: RecoveryObservation,
  journal: { readonly checkpointed: boolean; readonly claimPending: boolean },
): RecoveryClassification {
  if (journal.claimPending) return { state: "blocked", recoverable: false };
  if (observation.leaseHeldByOther) return { state: "active", recoverable: false };
  if (observation.missionTerminal) return { state: "terminal", recoverable: false };
  if (observation.permissionPending || observation.childPending) return { state: "blocked", recoverable: false };
  if (journal.checkpointed || observation.turnOpen) return { state: "unfinished", recoverable: true };
  return { state: "terminal", recoverable: false };
}

// ---------------------------------------------------------------------------
// The coordinator (observe → classify → claim → admit → settle, rate-limited)
// ---------------------------------------------------------------------------

/** The admission ACK's counts — the web's reconciliation numbers (R6: counted
 *  from structured data by the cli projection, never fabricated here). */
export interface RecoverySettle {
  readonly verifiedDone: number;
  readonly remaining: number;
}

/** The driver-shaped surface this coordinator speaks to (structural — no CLI
 *  import, the pet-lane precedent). M24 声明（§二.10）：port.admit 的注入发生
 *  在 resume 边界=冷转预期（cold turn expected）——恢复注入必然重放历史前
 *  缀之外的全新 user turn，前缀缓存不命中是本设计的已知代价，轮界时机补
 *  偿（恢复只在 boot/间隔≥2s 的轮界发生，绝不在运行中打断）。 */
export interface RecoveryPort {
  /** Boot-time extra candidates (mission in-flight sessions the disk scan
   *  names); merged with the journal-tracked set, deduped. */
  bootCandidates(): Promise<readonly string[]>;
  /** Observe one session; undefined = the session is gone/unreadable (the
   *  coordinator cancels its tracking — an honest drop, never a crash). */
  observe(sessionId: string): Promise<RecoveryObservation | undefined>;
  /** Resume the session and inject the verify-first recovery prompt (the
   *  NORMAL permission pipeline — invariant 8; this coordinator never
   *  bypasses anything). Resolves with the reconciliation counts; a
   *  rejection means the admission did not land (no settle is written). */
  admit(sessionId: string): Promise<RecoverySettle>;
  /** The driver's current session id (manual-input invalidation target). */
  currentSession(): string | undefined;
  /** Is a run in flight? (The admission gate — never interrupt a live run.) */
  busy(): boolean;
}

/** One row of the status surface (the recoveryStatus op's reply). */
export interface RecoveryStatusRow {
  readonly sessionId: string;
  readonly state: "blocked" | "active" | "recovering" | "unfinished" | "terminal" | "tracked";
  readonly verifiedDone?: number;
  readonly remaining?: number;
  /** ω99-248 — the waiting-for-human ask's evidence when the row is
   *  permission-blocked off the persistent record (the web's morning line
   *  「昨夜停在这里等你授权」; withdrawn once the record settles). */
  readonly permissionAsk?: {
    readonly toolName: string;
    readonly summary: string;
    readonly question: string;
  };
}

export interface RecoveryCoordinatorOptions {
  readonly journalPath: string;
  readonly port: RecoveryPort;
  /** Clock seam (tests inject a controlled one; default Date.now). */
  readonly now?: () => number;
  /** Admission start interval (default RECOVERY_INTERVAL_MS). */
  readonly intervalMs?: number;
  /** In-flight ceiling (default RECOVERY_CONCURRENCY). */
  readonly concurrency?: number;
  /** Observation rotation bound (default RECOVERY_ROTATION_BOUND). */
  readonly rotationBound?: number;
  /** Tick source; tests drive tick() directly and pass a no-op (the timer is
   *  never installed when this is provided). */
  readonly setTimer?: ((tick: () => void, intervalMs: number) => void) | undefined;
}

interface MemRecord extends FoldSessionState {
  /** Admitted THIS boot — never re-admitted until released (settled/removed). */
  admitted: boolean;
  /** The user took this session over manually THIS boot — never admitted
   *  here again (invariant 7; the journal's user-admit carries the next
   *  boot's tracking). */
  userOwned: boolean;
  /** The latest classification's state (undefined = not yet observed). */
  lastState?: RecoveryClassification["state"];
  /** The latest observation (dagRank source for the admission ordering). */
  lastObs?: RecoveryObservation;
}

export interface RecoveryCoordinator {
  /** One observe→classify→admit pass (coalesced: a tick while ticking joins
   *  the in-flight one — the openwork discipline). */
  tick(): Promise<void>;
  /** A manual client submit landed (invariant 7): cancels the pending
   *  recovery of the session the user took over (permission replies never
   *  reach this seam — the server wires ONLY the submit op here) and
   *  re-tracks it for the next crash. Fire-and-forget: journal IO must never
   *  break the submit path. */
  noteUserInput(): void;
  /** Structured rows for the web's reconciliation line. */
  status(): readonly RecoveryStatusRow[];
  /** Graceful-shutdown checkpoint (invariant 3): freeze the in-flight
   *  session BEFORE the engine dies. Must be awaited before the engine's
   *  close/abort. Idempotent; never checkpoints an idle session. */
  stop(): Promise<void>;
}

export function createRecoveryCoordinator(opts: RecoveryCoordinatorOptions): RecoveryCoordinator {
  const now = opts.now ?? ((): number => Date.now());
  const intervalMs = opts.intervalMs ?? RECOVERY_INTERVAL_MS;
  const concurrency = opts.concurrency ?? RECOVERY_CONCURRENCY;
  const rotationBound = opts.rotationBound ?? RECOVERY_ROTATION_BOUND;
  const journal = createRecoveryJournal(opts.journalPath);
  const mem = new Map<string, MemRecord>();
  let booted = false;
  let stopped = false;
  let ticking: Promise<void> | undefined;
  let nextLaunch = 0;
  let cursor = 0;

  const recOf = (sessionId: string): MemRecord => {
    const existing = mem.get(sessionId);
    if (existing !== undefined) return existing;
    const fresh: MemRecord = {
      sessionId, tracked: false, checkpointed: false, claimPending: false, lastAt: 0, admitted: false, userOwned: false,
    };
    mem.set(sessionId, fresh);
    return fresh;
  };

  const boot = async (): Promise<void> => {
    booted = true;
    const fold = await journal.fold();
    for (const s of fold.sessions.values()) {
      const rec = recOf(s.sessionId);
      rec.tracked = s.tracked;
      rec.checkpointed = s.checkpointed;
      rec.claimPending = s.claimPending;
      rec.verifiedDone = s.verifiedDone;
      rec.remaining = s.remaining;
      rec.lastAt = s.lastAt;
    }
    // ω99-242 §四: v1 recovers 「checkpoint 过的半轮 + mission in-flight」—
    // the disk scan names mission-bound sessions the journal never saw (the
    // pre-feature crash path). Deduped against the journal-tracked set.
    const extra = await opts.port.bootCandidates().catch((): readonly string[] => []);
    for (const id of extra) if (id !== "" && !mem.has(id)) recOf(id).tracked = true;
  };

  /** Cancel + untrack. `reason` is the honest cause (journal-visible). */
  const remove = async (sessionId: string, reason: string): Promise<void> => {
    await journal.append({ type: "cancel", sessionId, at: now(), reason });
    const rec = mem.get(sessionId);
    if (rec !== undefined) {
      rec.tracked = false;
      rec.checkpointed = false;
      rec.claimPending = false;
      rec.admitted = false;
    }
  };

  const check = async (sessionId: string): Promise<void> => {
    const rec = mem.get(sessionId);
    if (rec === undefined || !rec.tracked) return;
    const observation = await opts.port.observe(sessionId);
    if (observation === undefined) {
      await remove(sessionId, "gone");
      return;
    }
    const cls = classifyRecovery(observation, rec);
    rec.lastState = cls.state;
    rec.lastObs = observation;
    if (cls.state === "active" || cls.state === "blocked") return; // hold — observe only
    if (cls.state === "terminal") {
      await remove(sessionId, rec.admitted ? "settled" : "terminal");
      return;
    }
    // unfinished: recoverable — the admission phase below decides when.
  };

  const admitOne = async (rec: MemRecord): Promise<void> => {
    // ω99-242 invariant 2: claim durably BEFORE admission. A lost
    // acknowledgement is never retried — including across another restart
    // (the fold reads this claim back as claimPending → blocked).
    const at = now();
    await journal.append({ type: "claim", sessionId: rec.sessionId, at });
    rec.claimPending = true;
    rec.checkpointed = false;
    rec.admitted = true;
    nextLaunch = at + intervalMs;
    try {
      const settle = await opts.port.admit(rec.sessionId);
      rec.claimPending = false;
      rec.verifiedDone = settle.verifiedDone;
      rec.remaining = settle.remaining;
      await journal.append({
        type: "settle", sessionId: rec.sessionId, at: now(),
        verifiedDone: settle.verifiedDone, remaining: settle.remaining,
      });
    } catch (err) {
      // The admission did not land (resume refused / submit refused). The
      // claim discipline still holds — never silently retry: an honest cancel
      // with the cause, one stderr line for the operator, gone this boot.
      await remove(rec.sessionId, "admission-failed");
      process.stderr.write(
        `wudao-recovery: 恢复 admission 失败（${rec.sessionId}，本进程不再重试）：${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  };

  const tick = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (ticking !== undefined) return ticking;
    ticking = (async () => {
      try {
        if (!booted) await boot();
        const tracked = [...mem.values()].filter((r) => r.tracked);
        // Fairness (invariant 6): small backlogs observe in full; larger ones
        // rotate two per tick so background reads stay bounded and everyone
        // gets a turn.
        let selected: readonly MemRecord[];
        if (tracked.length <= rotationBound) {
          selected = tracked;
        } else {
          const a = tracked[cursor % tracked.length];
          const b = tracked[(cursor + 1) % tracked.length];
          cursor += concurrency;
          selected = a !== undefined && b !== undefined ? [...new Set([a, b])] : tracked.slice(0, 2);
        }
        await Promise.all([...new Set(selected)].map((rec) => check(rec.sessionId).catch(() => {
          // An unavailable/ambiguous observation never grants permission to
          // admit — the record keeps its state for the next tick.
        })));
        // Admission phase — SEQUENTIAL, mission-DAG-topological (invariant
        // 9), never while a run is in flight, capped, interval-spaced.
        const recoverable = [...mem.values()]
          .filter((r) => r.tracked && !r.admitted && !r.userOwned && r.lastState === "unfinished" && r.lastObs !== undefined)
          .sort((a, b) => (a.lastObs?.dagRank ?? Number.POSITIVE_INFINITY) - (b.lastObs?.dagRank ?? Number.POSITIVE_INFINITY) || a.lastAt - b.lastAt);
        for (const rec of recoverable) {
          if (opts.port.busy()) break; // never interrupt a live run
          const inFlight = [...mem.values()].filter((r) => r.tracked && r.admitted).length;
          if (inFlight >= concurrency) break; // the in-flight ceiling
          if (now() < nextLaunch) break; // the start interval
          await admitOne(rec);
        }
      } finally {
        ticking = undefined;
      }
    })();
    return ticking;
  };

  const install = opts.setTimer === undefined
    ? (cb: () => void, ms: number): void => {
        const t = setInterval(cb, ms);
        t.unref?.();
      }
    : opts.setTimer;
  install(() => void tick(), intervalMs);

  return {
    tick,
    noteUserInput: (): void => {
      if (stopped) return;
      const id = opts.port.currentSession();
      if (id === undefined) return;
      void (async () => {
        try {
          const rec = mem.get(id);
          // Invariant 7: the user's manual input voids THIS session's pending
          // recovery (a standing claim must not poison the next boot as a
          // lost ack — the takeover cancels it). The session STAYS tracked:
          // the user is driving entrusted work, and its next crash recovers.
          if (rec !== undefined && (rec.claimPending || rec.admitted || rec.checkpointed)) {
            await journal.append({ type: "cancel", sessionId: id, at: now(), reason: "user-input" });
            rec.claimPending = false;
            rec.admitted = false;
            rec.checkpointed = false;
            rec.tracked = true;
          }
          await journal.append({ type: "admit", sessionId: id, at: now(), user: true });
          const target = rec ?? recOf(id);
          target.tracked = true;
          target.lastAt = now();
          target.userOwned = true;
        } catch {
          // Journal IO is best-effort here — never break the submit path.
        }
      })();
    },
    status: (): readonly RecoveryStatusRow[] => {
      const rows: RecoveryStatusRow[] = [];
      for (const rec of mem.values()) {
        if (!rec.tracked) continue; // removed/terminal records report nothing
        const state: RecoveryStatusRow["state"] = rec.claimPending
          ? "blocked"
          : rec.admitted
            ? "recovering"
            : rec.lastState === "active" || rec.lastState === "blocked" || rec.lastState === "unfinished" || rec.lastState === "terminal"
              ? rec.lastState
              : "tracked";
        rows.push({
          sessionId: rec.sessionId,
          state,
          ...(rec.verifiedDone !== undefined ? { verifiedDone: rec.verifiedDone } : {}),
          ...(rec.remaining !== undefined ? { remaining: rec.remaining } : {}),
          // ω99-248 — thread the record-sourced ask evidence into the row (the
          // morning line's data source); the latest observation owns it and it
          // disappears the moment the record settles (落定不复活).
          ...(rec.lastObs?.pendingAsk !== undefined ? { permissionAsk: rec.lastObs.pendingAsk } : {}),
        });
      }
      return rows;
    },
    stop: async (): Promise<void> => {
      if (stopped) return;
      stopped = true;
      // Invariant 3: freeze BEFORE engines are killed, so the kill's own
      // idle/abort can never erase the recovery intent. Only a session with
      // a run actually in flight is checkpointed — idle is not intent.
      const id = opts.port.currentSession();
      if (id !== undefined && opts.port.busy()) {
        await journal.append({ type: "checkpoint", sessionId: id, at: now() });
        const rec = mem.get(id);
        if (rec !== undefined) {
          rec.checkpointed = true;
          rec.tracked = true;
        }
      }
    },
  };
}
