// M49 §1 — the memory store: `.wudao/memory.jsonl`, append-only, one JSON
// entry per line. Every write passes the ASSESSMENT (assess.ts) first:
// auto-allow only for bounded / non-sensitive / relatively-new / project-scope
// content; everything else lands in the PENDING review queue (surfaced to the
// user once at the next session start; /memory ok confirms, /memory del drops).
// User-scope writes NEVER auto-allow — the strongest form of "never write the
// user domain directly" (§2's background review rides the same gate).
//
// ω99-3a (Continual Harness stage 1) adds the /refine extensions: a fourth
// kind "harness" (operational notes about HOW the agent should work — tool
// lessons, plan-gate timing, workflow preferences; NOT project facts), the
// versioned `update` (same id, version+1, ALWAYS back to pending — LLM
// curation never re-activates itself), `forcePending` on write (the same
// discipline for creates), and `rollback` (reverses a refine from the
// before/after snapshots in .wudao/memory-refinements.jsonl). Dream's
// additions-only flow (D3) is untouched: update/rollback are explicit verbs
// that belong to /refine alone.
import { randomUUID, randomBytes } from "node:crypto";
import { mkdir, readFile, appendFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { tokenSet, jaccard } from "../tokenize.js";
import { appendRefinementAuditAt, readRefinementAuditAt } from "./refinements.js";
import type { RefineEdit } from "./refinements.js";
// 永续 v6 弧 A（reef C3）——学习入口防污染的块档门：凭据值/指令覆盖形状在
// write()/update()（全部四条学习入口的汇聚点）之前硬拦。拦下的内容不落
// 台账、不进 pending（pending 会把密钥明文持久化），改落可见的拦截台账。
// 台账路径跟随本 store 自己的路径（会话自定 memoryDirectory 自动生效）。
import { appendBlockedLearningAt, buildBlockedRecord, screenLearningInput } from "./guard.js";
import type { LearningSource } from "./guard.js";

export type MemoryKind = "fact" | "preference" | "skill_note" | "harness";
export type MemoryScope = "project" | "user";

/** One memory.jsonl line. `hits` is the shadow-ranking telemetry (incremented
 *  each time an entry is auto-recalled — observed only, never feeds ranking
 *  yet; "不做模型侧自动调权"). */
export interface MemoryEntry {
  readonly id: string;
  readonly kind: MemoryKind;
  readonly content: string;
  readonly scope: MemoryScope;
  readonly tags: readonly string[];
  readonly created: string;
  readonly hits: number;
  /** active = recalled/searchable; pending = awaiting the user's one-time
   *  confirmation (surfaced at the next session start). */
  readonly status: "active" | "pending";
  /** Set once a pending entry has been surfaced (the "一次性" rule: the
   *  reminder fires once, the decision stays open in /memory list). */
  readonly surfaced?: boolean;
  /** ω-4f (design 84 §3(b)): the monotonic ledger sequence — Dream's durable
   *  cursor rides it. Assigned by the store handle's sync counter before any
   *  await; legacy lines without a seq derive one from file order at parse
   *  time. Round-tripped by rewriteAll, so confirm/del/bump never shift it
   *  (the property a line-index cursor cannot have). */
  readonly seq?: number;
  /** ω99-3a: the version chain for /refine's update path. 1 on write, +1 per
   *  update (and +1 again per rollback-restore). Optional in the TYPE because
   *  pre-ω99-3a lines lack it; parseEntry normalizes those to 1, so every
   *  entry a handle returns carries a version. */
  readonly version?: number;
}

export function memoryStorePath(workspaceRoot: string): string {
  return `${workspaceRoot}/.wudao/memory.jsonl`;
}

const KINDS: readonly MemoryKind[] = ["fact", "preference", "skill_note", "harness"];
const SCOPES: readonly MemoryScope[] = ["project", "user"];

/** ω-4f: `ordinal` is the 1-based file-order position of this line among the
 *  PARSED entries — the seq a legacy (seq-less) line derives, so every entry
 *  a handle ever returns carries a seq. */
function parseEntry(raw: unknown, ordinal: number): MemoryEntry | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.content !== "string") return undefined;
  if (!KINDS.includes(r.kind as MemoryKind) || !SCOPES.includes(r.scope as MemoryScope)) return undefined;
  if (typeof r.created !== "string" || typeof r.hits !== "number") return undefined;
  const status = r.status === "pending" ? "pending" : "active";
  const seq = typeof r.seq === "number" && Number.isInteger(r.seq) && r.seq >= 0 ? r.seq : ordinal;
  // ω99-3a: version is normalized (never absent in memory) so update/rollback
  // can do plain `version + 1` arithmetic; junk values read as v1.
  const version = typeof r.version === "number" && Number.isInteger(r.version) && r.version >= 1 ? r.version : 1;
  return {
    id: r.id,
    kind: r.kind as MemoryKind,
    content: r.content,
    scope: r.scope as MemoryScope,
    tags: Array.isArray(r.tags) ? r.tags.filter((t): t is string => typeof t === "string") : [],
    created: r.created,
    hits: r.hits,
    status,
    seq,
    version,
    ...(r.surfaced === true ? { surfaced: true } : {}),
  };
}

export interface MemoryStore {
  /** All entries in file order (active + pending). */
  load(): Promise<readonly MemoryEntry[]>;
  /** Active entries only (the recall/search pool). */
  active(): Promise<readonly MemoryEntry[]>;
  /** Pending, not-yet-surfaced entries (the next-session review prompt). */
  pendingReview(): Promise<readonly MemoryEntry[]>;
  /** Mark the given pending entries surfaced (the one-time reminder). */
  markSurfaced(ids: readonly string[]): Promise<void>;
  /** The assessed write (§1): appends an ACTIVE entry on auto-allow, a
   *  PENDING entry otherwise. Returns the decision for receipts.
   *  永续 v6 弧 A：凭据值/指令覆盖形状在评估之前 BLOCKED（ok:false——
   *  未入台账，拦截台账留痕可见）；其余语义逐字不变。
   *  ω99-3a: `forcePending: true` (the /refine create path) skips the
   *  auto-allow branch entirely — LLM curation lands pending, full stop. */
  write(input: MemoryWriteInput): Promise<MemoryWriteResult>;
  /** ω99-3a: version-bumped update. 写回同一 id 的新内容行（version+1），
   *  条目转 pending（LLM 策展不过人审不落 active——update 后必须 /memory ok），
   *  before 快照进审计。返回更新后条目；id 不存在 → undefined；
   *  新内容被防污染门拦下 → "blocked"（未改写一行，拦截台账留痕）。 */
  update(id: string, input: { readonly content: string; readonly tags?: readonly string[]; readonly source?: LearningSource }): Promise<MemoryEntry | "blocked" | undefined>;
  /** ω99-3a: 按审计里的 refineId 整体回滚（逆向应用其全部 edits）。不存在 → false。 */
  rollback(refineId: string): Promise<boolean>;
  /** Hard delete by id (the /memory del command). */
  remove(id: string): Promise<boolean>;
  /** Pending → active (the /memory ok confirmation). */
  confirm(id: string): Promise<boolean>;
  /** Shadow-ranking telemetry: +1 hit per named entry. */
  bumpHits(ids: readonly string[]): Promise<void>;
  readonly path: string;
}

export interface MemoryWriteInput {
  readonly kind: MemoryKind;
  readonly content: string;
  readonly scope?: MemoryScope;
  readonly tags?: readonly string[];
  /** ω99-3a: refine-path writes NEVER auto-allow — forcePending skips the
   *  assessment's auto branch and lands the entry pending directly. The
   *  pure assessMemoryWrite is unchanged; the flag is consumed here, in
   *  write(), so every other caller keeps today's semantics. */
  readonly forcePending?: boolean;
  /** 永续 v6 弧 A（reef C3）：这条写入来自哪条学习入口（拦截台账的归因
   *  维度；默认 memory_write——模型工具面、评审 fork、dream 子代理都从
   *  那道门进）。 */
  readonly source?: LearningSource;
}

export type MemoryWriteResult =
  | { readonly ok: true; readonly entry: MemoryEntry; readonly decision: "auto"; readonly reasons: readonly string[] }
  | { readonly ok: true; readonly entry: MemoryEntry; readonly decision: "pending"; readonly reasons: readonly string[] }
  | { readonly ok: false; readonly blocked: true; readonly reasons: readonly string[] };

/** Opens the store handle (pure construction — every method owns its IO, so
 *  callers can open synchronously at build time, e.g. the TUI's tool-set
 *  memo). A nonexistent file behaves as an empty store until the first write. */
export function openMemoryStore(workspaceRoot: string): MemoryStore {
  return openMemoryStoreAt(memoryStorePath(workspaceRoot));
}

/** ω-4f (design 84 §3(a)): the effective memory DIRECTORY — `<root>/.wudao`
 *  by default, the session's custom memoryDirectory when set. Dream's cursor
 *  and audit files live beside the ledger, so they follow it. */
export function memoryDirectory(workspaceRoot: string): string {
  return dirname(sessionMemory !== undefined ? sessionMemory.path : memoryStorePath(workspaceRoot));
}

/** M62 §7: the session's memory settings (memoryEnabled +
 *  memoryDirectory), set once at startup from the layered settings.
 *  Absent → the M49 defaults (enabled, <root>/.wudao/memory.jsonl). */
let sessionMemory: { readonly enabled: boolean; readonly path: string } | undefined;

/** Set the session's memory settings (startup-only; first call wins). */
export function setSessionMemorySettings(settings: { readonly enabled: boolean; readonly path: string } | undefined): void {
  if (sessionMemory !== undefined) return;
  sessionMemory = settings;
}

/** The session-aware store factory: honors memoryEnabled:false (→
 *  undefined — zero memory surface, the pre-M49 tool set) and
 *  memoryDirectory (custom path). Falls back to the M49 default. */
export function openSessionMemoryStore(workspaceRoot: string): MemoryStore | undefined {
  if (sessionMemory !== undefined) {
    if (!sessionMemory.enabled) return undefined;
    return openMemoryStoreAt(sessionMemory.path);
  }
  return openMemoryStore(workspaceRoot);
}

function openMemoryStoreAt(path: string): MemoryStore {
  let ensured = false;
  // ω-4f: the handle's seq counter. Initialized to max(seq)+1 at the first
  // readAll; `write()` then assigns `seq = next++` synchronously between its
  // readAll await and its append await, so interleaved write starts can never
  // share a seq (single-threaded JS closes nanobot's threading.Lock gap).
  // Per HANDLE by design — the driver opens one store (as the review fork
  // does); two live handles could double-assign (design 84 §6 risk 2).
  let nextSeq: number | undefined;

  const readAll = async (): Promise<readonly MemoryEntry[]> => {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch {
      // An absent store is empty (the counter still initializes below so the
      // first write gets seq 1 even on a fresh workspace).
      if (nextSeq === undefined) nextSeq = 1;
      return [];
    }
    const out: MemoryEntry[] = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = parseEntry(JSON.parse(trimmed), out.length + 1);
        if (parsed) out.push(parsed);
      } catch {
        // skip a corrupt line rather than aborting the store
      }
    }
    if (nextSeq === undefined) {
      let max = 0;
      for (const e of out) {
        const s = e.seq ?? 0;
        if (s > max) max = s;
      }
      nextSeq = max + 1;
    }
    return out;
  };

  const appendLine = async (entry: MemoryEntry): Promise<void> => {
    if (!ensured) {
      await mkdir(dirname(path), { recursive: true });
      ensured = true;
    }
    await appendFile(path, `${JSON.stringify(entry)}\n`);
  };

  // Rewrite-all (used only by the small bookkeeping flips — confirm/mark/
  // bump/del — never by content appends, which stay append-only).
  const rewriteAll = async (entries: readonly MemoryEntry[]): Promise<void> => {
    if (!ensured) {
      await mkdir(dirname(path), { recursive: true });
      ensured = true;
    }
    await writeFile(path, entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length > 0 ? "\n" : ""), "utf8");
  };

  return {
    path,
    async load() {
      return readAll();
    },
    async active() {
      return (await readAll()).filter((e) => e.status === "active");
    },
    async pendingReview() {
      return (await readAll()).filter((e) => e.status === "pending" && e.surfaced !== true);
    },
    async markSurfaced(ids) {
      if (ids.length === 0) return;
      const entries = await readAll();
      const set = new Set(ids);
      await rewriteAll(entries.map((e) => (set.has(e.id) ? { ...e, surfaced: true } : e)));
    },
    async write(input) {
      // 永续 v6 弧 A（reef C3）——块档门在评估之前：凭据值/指令覆盖形状
      // 根本不进台账（pending 也会把密钥明文持久化）。拦下=留痕可见台账，
      // 绝不静默丢。台账落盘失败不掩盖拦截决定（决定已成立，日志尽力而为）。
      const screen = screenLearningInput(input.content);
      if (screen.blocked) {
        await appendBlockedLearningAt(path, buildBlockedRecord({ at: new Date().toISOString(), source: input.source ?? "memory_write", reasons: screen.reasons, content: input.content })).catch(() => {});
        return { ok: false, blocked: true, reasons: screen.reasons };
      }
      const existing = await readAll();
      // ω99-3a: forcePending (the /refine create path) skips the auto-allow
      // BRANCH — the decision is pending regardless of what the pure gates
      // would say, because LLM curation never activates itself. assessMemory
      // Write itself is unchanged (pure, side-effect-free) and still runs so
      // the non-forced path below keeps byte-identical semantics.
      const forced = input.forcePending === true;
      const assessment = assessMemoryWrite(input, existing);
      const decision: "auto" | "pending" = forced ? "pending" : assessment.decision;
      // ω-4f: seq assignment runs BEFORE any await below — the atomic window
      // between the readAll and append awaits is what keeps interleaved
      // writes distinct.
      const seq = nextSeq ?? 1;
      nextSeq = seq + 1;
      const entry: MemoryEntry = {
        id: `m-${randomUUID().split("-")[0]}`,
        kind: input.kind,
        content: input.content,
        scope: input.scope ?? "project",
        tags: [...(input.tags ?? [])],
        created: new Date().toISOString(),
        hits: 0,
        status: decision === "auto" ? "active" : "pending",
        seq,
        version: 1,
      };
      await appendLine(entry);
      return {
        ok: true,
        entry,
        decision,
        reasons: forced ? ["forced pending (/refine path): LLM curation never auto-activates"] : assessment.reasons,
      };
    },
    async update(id, input) {
      const entries = await readAll();
      const target = entries.find((e) => e.id === id);
      if (target === undefined) return undefined;
      // 永续 v6 弧 A——改写与新建同一道门：被拦的改写不动原行、不 bump
      // 版本（「blocked」与「id 不存在」是两件事，回执分开说清）。
      const screen = screenLearningInput(input.content);
      if (screen.blocked) {
        await appendBlockedLearningAt(path, buildBlockedRecord({ at: new Date().toISOString(), source: input.source ?? "edit", reasons: screen.reasons, content: input.content })).catch(() => {});
        return "blocked";
      }
      // A version bump is a ledger event like any write: the updated line
      // takes a FRESH seq (so Dream's unprocessed batch re-sees the changed
      // content) and the counter advances before the rewrite await (ω-4f).
      const seq = nextSeq ?? 1;
      nextSeq = seq + 1;
      // Built field-by-field (NOT spread): `surfaced` must drop so the
      // pending entry re-enters the one-time next-session reminder — the
      // update re-opens the human decision the way a fresh write would.
      const updated: MemoryEntry = {
        id: target.id,
        kind: target.kind,
        scope: target.scope,
        tags: input.tags !== undefined ? [...input.tags] : target.tags,
        created: target.created,
        hits: target.hits,
        content: input.content,
        status: "pending",
        seq,
        version: (target.version ?? 1) + 1,
      };
      await rewriteAll(entries.map((e) => (e.id === id ? updated : e)));
      return updated;
    },
    async rollback(refineId) {
      // The audit lives beside THIS store's ledger (session directory
      // included) — never assume the workspace default.
      const trail = await readRefinementAuditAt(path);
      const target = trail.find((l) => l.refineId === refineId && l.outcome === "applied");
      if (target === undefined) return false;
      let entries = await readAll();
      // Reverse-apply in REVERSE order (prime-agent rollbackProposal
      // :813-845's discipline): create → remove; update → restore the
      // before snapshot at version+1 (a NEW ledger event, fresh seq — the
      // chain must show the restore, never pretend it didn't happen);
      // delete → nothing (the suggestion never executed).
      const reverseEdits: RefineEdit[] = [];
      for (const edit of [...target.edits].reverse()) {
        if (edit.id === undefined) continue;
        const current = entries.find((e) => e.id === edit.id);
        if (edit.action === "create") {
          if (current === undefined) continue; // already gone — nothing to reverse
          entries = entries.filter((e) => e.id !== edit.id);
          reverseEdits.push({
            action: "delete",
            id: edit.id,
            kind: current.kind,
            before: { content: current.content, version: current.version ?? 1, status: current.status },
          });
        } else if (edit.action === "update" && edit.before !== undefined) {
          if (current === undefined) continue; // gone; the audit line still holds the content
          const seq = nextSeq ?? 1;
          nextSeq = seq + 1;
          const restored: MemoryEntry = {
            id: current.id,
            kind: current.kind,
            scope: current.scope,
            tags: current.tags,
            created: current.created,
            hits: current.hits,
            content: edit.before.content,
            status: edit.before.status === "pending" ? "pending" : "active",
            seq,
            version: (current.version ?? 1) + 1,
          };
          entries = entries.map((e) => (e.id === edit.id ? restored : e));
          reverseEdits.push({
            action: "update",
            id: edit.id,
            kind: current.kind,
            before: { content: current.content, version: current.version ?? 1, status: current.status },
            after: { content: restored.content, version: restored.version ?? 1, status: restored.status },
          });
        }
      }
      if (reverseEdits.length > 0) await rewriteAll(entries);
      // The rollback is itself an audited refine-shaped event (its own
      // refineId; rolling back a rollback works through the same path).
      await appendRefinementAuditAt(path, {
        refineId: `rf-${randomBytes(4).toString("hex")}`,
        at: new Date().toISOString(),
        trigger: "manual",
        summary: `rollback of ${refineId}`,
        rationale: `Reverse-applied every edit of refinement ${refineId} from its audit snapshots.`,
        expectedOutcome: "The entries that refinement touched return to their before states.",
        edits: reverseEdits,
        outcome: "applied",
      });
      return true;
    },
    async remove(id) {
      const entries = await readAll();
      const next = entries.filter((e) => e.id !== id);
      if (next.length === entries.length) return false;
      await rewriteAll(next);
      return true;
    },
    async confirm(id) {
      const entries = await readAll();
      const target = entries.find((e) => e.id === id);
      if (target === undefined || target.status !== "pending") return false;
      await rewriteAll(entries.map((e) => (e.id === id ? { ...e, status: "active" as const, surfaced: true } : e)));
      return true;
    },
    async bumpHits(ids) {
      if (ids.length === 0) return;
      const entries = await readAll();
      const set = new Set(ids);
      const touched = entries.some((e) => set.has(e.id));
      if (!touched) return;
      await rewriteAll(entries.map((e) => (set.has(e.id) ? { ...e, hits: e.hits + 1 } : e)));
    },
  };
}

// ---------------------------------------------------------------------------
// Write assessment (§1): auto-allow ONLY when bounded + non-sensitive +
// relatively-new + project-scope. Everything else → pending review.
// ---------------------------------------------------------------------------

/** Credential-shaped content (case-insensitive). A hit means "sensitive" —
 *  the write goes to pending review, never auto-allows. Broad by design:
 *  naming a secret-shaped field is itself worth a human look. */
export const CREDENTIAL_RE =
  /(api[_-]?key|apikey|secret|passwd|password|passphrase|access[_-]?token|auth[_-]?token|bearer\s+[a-z0-9._~+/=-]{8,}|sk-[a-z0-9]{8,}|ghp_[a-z0-9]{16,}|gho_[a-z0-9]{16,}|github_pat_[a-z0-9_]{20,}|xox[abprs]-[a-z0-9-]{10,}|akia[0-9a-z]{16}|-----begin [a-z0-9 ]*private key-----)/i;

/** Auto-allow bound (spec: 有界 ≤500 chars). */
export const MEMORY_MAX_CONTENT_CHARS = 500;
/** Novelty bound (spec: 相对新增 — Jaccard < 0.7 vs every existing entry). */
export const MEMORY_NOVELTY_JACCARD = 0.7;

export interface MemoryAssessment {
  readonly decision: "auto" | "pending";
  readonly reasons: readonly string[];
}

/** Pure: assess one write against the existing entries. ALL four gates must
 *  pass for auto; each failed gate names itself in `reasons`. */
export function assessMemoryWrite(input: MemoryWriteInput, existing: readonly MemoryEntry[]): MemoryAssessment {
  const reasons: string[] = [];
  if (input.content.length > MEMORY_MAX_CONTENT_CHARS) {
    reasons.push(`bounded: ${input.content.length} > ${MEMORY_MAX_CONTENT_CHARS} chars`);
  }
  if (CREDENTIAL_RE.test(input.content)) {
    reasons.push("sensitive: content looks credential-shaped");
  }
  const incoming = tokenSet(input.content);
  let maxSimilarity = 0;
  let mostSimilar: MemoryEntry | undefined;
  for (const e of existing) {
    const s = jaccard(incoming, tokenSet(e.content));
    if (s > maxSimilarity) {
      maxSimilarity = s;
      mostSimilar = e;
    }
  }
  if (maxSimilarity >= MEMORY_NOVELTY_JACCARD) {
    reasons.push(`novelty: Jaccard ${maxSimilarity.toFixed(2)} ≥ ${MEMORY_NOVELTY_JACCARD} vs ${mostSimilar?.id ?? "?"}`);
  }
  const scope = input.scope ?? "project";
  if (scope !== "project") {
    reasons.push(`scope: "${scope}" never auto-allows (project-only)`);
  }
  return { decision: reasons.length === 0 ? "auto" : "pending", reasons };
}

// ---------------------------------------------------------------------------
// 借鉴弧 C2（SoL-Pi C4）— 盲 held-out 的精化入口标记。
// 纪律：从盲 held-out 评估结果派生的记忆条目必须携带 heldout 标签；
// /refine 与 Dream 的输入组装处（refine.ts / dream.ts）以此标签过滤——
// 密封套件的结果永不进入任何精化输入。套件名单本身密封在
// packages/evals/contracts.json 的 heldout 节（cli 不依赖 evals——标记
// 机制在此，名单在彼，leakScan 是弧侧的自检工具）。
// ---------------------------------------------------------------------------

/** The tag that marks a memory entry as derived from blind held-out evidence. */
export const HELDOUT_MEMORY_TAG = "heldout";

/** True when the entry is sealed from refinement inputs (Dream/refine never
 *  see it; the human's /memory verbs are unaffected — 只过滤精化，不过滤人). */
export function isHeldOutEntry(entry: MemoryEntry): boolean {
  return entry.tags.includes(HELDOUT_MEMORY_TAG);
}
