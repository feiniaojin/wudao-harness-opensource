// ω-4f (design 84) — Dream memory consolidation: stage 2 of the two-stage
// composition. The review fork (M49) turns a settled transcript into assessed
// ledger entries (stage 1, shipped); Dream periodically re-reads the WHOLE
// ledger and consolidates it — deduping/merging paraphrases into durable
// entries — through a fresh registry child whose entire tool registry is
// {memory_write, memory_search} (construction-enforced: no path-shaped tool,
// no shell, no task spawn). Additions only in v1 (D3): merges name superseded
// ids in the report; /memory del stays the deletion verb.
//
// Cursor (D1/D7): a monotonic seq over `.wudao/memory.jsonl` entries, state
// in `<memoryDir>/dream-cursor.json` — advanced only after the completion
// gate (RegistryResult.ok, D5) and only through the captured batch. Audit
// (D6): ONE append to `<memoryDir>/dream.jsonl` per run, diff-grounded from a
// pre/post-spawn store id-diff — never the model's self-report. Skip-don't-
// corrupt: every step sits in the review-fork try/catch shape; a failed dream
// never breaks the run it rode. M24: zero cache cost — Dream is a separate
// child with its own prompt; parent ModelInput bytes are untouched throughout.
import { truncateSafe } from "@wudao/core"; // 113-A4
import { mkdir, readFile, appendFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ModelClient } from "@wudao/core";
import type { AgentRegistry } from "../agents/index.js";
import { memoryDirectory, openSessionMemoryStore, isHeldOutEntry, type MemoryEntry } from "./store.js";
import { createMemoryWriteTool, createMemorySearchTool } from "./tools.js";
// 永续 v6 弧 A（the upstream project C3）：学习输入的 nonce 围栏（见 buildDreamPrompt）。
import { fenceUntrusted } from "./guard.js";

export const DREAM_ROLE_ID = "memory-dream";
/** Registry spawn maxTurns (the kernel-policy childTurns ceiling still applies). */
export const DREAM_MAX_TURNS = 4;
/** A hung child must not pin a registry slot (registry.ts timeoutMs). */
export const DREAM_TIMEOUT_MS = 120_000;
/** Batch size: entries past the cursor per run (the upstream project memory.py:579 default). */
export const DREAM_BATCH_MAX_ENTRIES = 20;
/** Whole-embed cap (the upstream project :67), applied to the WHOLE embedded ledger section. */
export const DREAM_EMBED_MAX_CHARS = 8000;
/** Per-entry truncation (pending entries can exceed 500 at full length). */
export const DREAM_EMBED_ENTRY_CHARS = 400;
/** Due-gate: minimum unprocessed entries before a dream is worth spawning. */
export const DREAM_MIN_UNPROCESSED = 8;
/** Due-gate: minimum spacing between attempts (any outcome). */
export const DREAM_MIN_INTERVAL_MS = 30 * 60_000;

const TRUNCATION_FOOTER = "...[truncated]";

export const DREAM_PROMPT = [
  "Consolidate the workspace memory ledger. The UNPROCESSED BATCH below has accumulated since the last consolidation pass.",
  "Compare it against the CURRENT LEDGER (the ground-truth embed below) — propose against what actually exists, not a stale mental model.",
  "Dedupe and merge: when the batch repeats or paraphrases what the ledger already holds, write ONE durable merged entry via memory_write (kind: fact|preference|skill_note; content ≤500 chars, self-contained; never secrets or credentials; scope stays project).",
  "Name the ids your new entry supersedes in your final report — the human deletes them with /memory del <id>; you cannot delete anything yourself.",
  "NEVER enshrine unconfirmed content: entries marked pending await the user's review — do not restate their content as established fact.",
  "Check with memory_search first when unsure. An empty ledger section means propose nothing. If nothing qualifies, write nothing and answer briefly.",
].join("\n");

/** The dream child's own system prompt (fresh child — no prefix-fork, so it
 *  needs no byte stability; short and role-specific by design). */
export const DREAM_SYSTEM_PROMPT = [
  "You are the memory consolidation worker (dream) for this workspace.",
  "Your only tools are memory_write and memory_search: you curate the memory ledger, nothing else — no files, no shell, no sub-agents.",
  "Every memory_write is assessed (short, non-sensitive, novel, project-scope notes save immediately; everything else queues for human review) — you never bypass it.",
].join("\n");

// ---------------------------------------------------------------------------
// Cursor (§3(a)) — `<memoryDir>/dream-cursor.json`.
// ---------------------------------------------------------------------------

export interface DreamCursor {
  /** Consolidation has processed every ledger entry with seq ≤ this. */
  readonly lastSeq: number;
  /** ISO time of the last attempt (any outcome) — paces DREAM_MIN_INTERVAL_MS. */
  readonly lastRunAt?: string;
  /** false → the last attempt aborted; the next due-check retries the same span. */
  readonly lastRunOk?: boolean;
}

export function dreamCursorPath(workspaceRoot: string): string {
  return join(memoryDirectory(workspaceRoot), "dream-cursor.json");
}

export function dreamAuditPath(workspaceRoot: string): string {
  return join(memoryDirectory(workspaceRoot), "dream.jsonl");
}

/** Unreadable/corrupt/absent → {lastSeq:0} — fail toward REPROCESSING the
 *  ledger, never toward silently skipping it (D9; the upstream project's skip-to-latest
 *  upgrade default was explicitly declined). */
export async function readDreamCursor(workspaceRoot: string): Promise<DreamCursor> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(dreamCursorPath(workspaceRoot), "utf8"));
  } catch {
    return { lastSeq: 0 };
  }
  if (typeof raw !== "object" || raw === null) return { lastSeq: 0 };
  const r = raw as Record<string, unknown>;
  const lastSeq = typeof r.lastSeq === "number" && Number.isInteger(r.lastSeq) && r.lastSeq >= 0 ? r.lastSeq : 0;
  return {
    lastSeq,
    ...(typeof r.lastRunAt === "string" ? { lastRunAt: r.lastRunAt } : {}),
    ...(r.lastRunOk === true || r.lastRunOk === false ? { lastRunOk: r.lastRunOk } : {}),
  };
}

/** Whole-file write, post-settle only (the spawn advances the cursor AFTER the
 *  completion gate — never before). */
export async function writeDreamCursor(workspaceRoot: string, c: DreamCursor): Promise<void> {
  const p = dreamCursorPath(workspaceRoot);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, `${JSON.stringify(c)}\n`, "utf8");
}

// ---------------------------------------------------------------------------
// Pure helpers (§3(c)/(f)).
// ---------------------------------------------------------------------------

/** True unless WUDAO_DREAM=off or WUDAO_NO_DREAM_FORK=1 (the review fork's
 *  env style, review.ts:26-29). */
export function dreamEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.WUDAO_NO_DREAM_FORK === "1") return false;
  return (env.WUDAO_DREAM ?? "").trim().toLowerCase() !== "off";
}

/** The pure due-check (§3(f)): enabled AND enough backlog AND spaced from the
 *  last attempt. The single-flight (no dream in flight) is enforced at the
 *  spawn, not here. */
export function dreamDue(cursor: DreamCursor, unprocessedCount: number, now: number, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!dreamEnabled(env)) return false;
  if (unprocessedCount < DREAM_MIN_UNPROCESSED) return false;
  if (cursor.lastRunAt !== undefined) {
    const last = Date.parse(cursor.lastRunAt);
    // An unparseable lastRunAt cannot pace anything — treat as long-elapsed.
    if (!Number.isNaN(last) && now - last < DREAM_MIN_INTERVAL_MS) return false;
  }
  return true;
}

function dreamLine(e: MemoryEntry): string {
  const content = e.content.length <= DREAM_EMBED_ENTRY_CHARS
    ? e.content
    : `${truncateSafe(e.content, DREAM_EMBED_ENTRY_CHARS)}${TRUNCATION_FOOTER}`;
  return `- [${e.id} ${e.kind}/${e.scope} ${e.status}] ${content}`;
}

/** The ground-truth ledger embed (§3(c)): every entry one line, per-entry
 *  truncation, whole section ≤ DREAM_EMBED_MAX_CHARS with a `...[truncated]`
 *  footer when entries drop — the upstream project `_render_current_memory_files`'s
 *  guarantee translated: the model edits the real ledger, not a stale mental
 *  model. Exported pure for T3. */
export function renderDreamLedgerEmbed(entries: readonly MemoryEntry[]): string {
  // 借鉴弧 C2：heldout 标记条目不进 ground-truth 嵌入（buildDreamPrompt 的
  // 入口过滤之外，视图自身也强制——密封证据不进任何精化视图）。
  const visible = entries.filter((e) => !isHeldOutEntry(e));
  if (visible.length === 0) return "(empty)";
  const out: string[] = [];
  let used = 0;
  // Whole lines only; the footer reserves its own + newline budget so the
  // section can never exceed the cap.
  const budget = DREAM_EMBED_MAX_CHARS - TRUNCATION_FOOTER.length - 1;
  for (const e of visible) {
    const line = dreamLine(e);
    const extra = out.length > 0 ? 1 : 0;
    if (used + extra + line.length > budget) return `${out.join("\n")}\n${TRUNCATION_FOOTER}`;
    out.push(line);
    used += extra + line.length;
  }
  return out.join("\n");
}

export interface DreamPromptInput {
  /** The FULL ledger load (file order, active + pending — D10). */
  readonly entries: readonly MemoryEntry[];
  readonly cursor: DreamCursor;
}

export interface DreamPrompt {
  readonly prompt: string;
  /** The captured batch's last seq — the only value the cursor may advance to. */
  readonly lastSeq: number;
}

/** Pure (§3(c)): split the ledger into the unprocessed batch (seq > cursor,
 *  file order, first DREAM_BATCH_MAX_ENTRIES) and the embedded current
 *  ledger. `lastSeq` is the batch's last seq — entries appended during the
 *  run (the child's own memory_write output included) stay eligible next run
 *  (the upstream project memory.py:1190-1192: advance only through the captured batch).
 *  Nothing unprocessed → undefined.
 *
 *  借鉴弧 C2（the upstream project C4）：heldout 标记条目不进批也不进 ground-truth 嵌入
 *  ——密封套件的结果永不进入精化输入。lastSeq 取自「seq 批」（过滤前），
 *  游标照常越过密封条目（它们永不阻塞、永不反复计数）；若批在过滤后为
 *  空，返回 undefined（不出模型调用），且 due-gate 的计数同样排除它们，
 *  不会空转。 */
export function buildDreamPrompt(input: DreamPromptInput): DreamPrompt | undefined {
  const seqBatch = input.entries
    .filter((e) => (e.seq ?? 0) > input.cursor.lastSeq)
    .slice(0, DREAM_BATCH_MAX_ENTRIES);
  if (seqBatch.length === 0) return undefined;
  const last = seqBatch[seqBatch.length - 1]!;
  const unprocessed = seqBatch.filter((e) => !isHeldOutEntry(e));
  if (unprocessed.length === 0) return undefined;
  return {
    prompt: [
      DREAM_PROMPT,
      "",
      "## Unprocessed batch (ledger entries since the last consolidation pass)",
      // 永续 v6 弧 A（the upstream project C3）：台账条目=不可信文本（pending 条目可含任意
      // 模型产出），nonce 围栏防块内文本冒充提示词作者。围栏只进本 fresh
      // child 提示词——M24 零代价（Dream 自有前缀，父会话字节不动）。
      fenceUntrusted(unprocessed.map(dreamLine).join("\n"), "dream-batch"),
      "",
      "## Current ledger (ground truth)",
      // 并集解（A 围栏 × C heldout 过滤正交：先滤盲测条目，再对剩余围栏）。
      fenceUntrusted(renderDreamLedgerEmbed(input.entries.filter((e) => !isHeldOutEntry(e))), "dream-ledger"),
    ].join("\n"),
    lastSeq: last.seq ?? input.cursor.lastSeq,
  };
}

/** Count of ledger entries past the cursor (the due-gate input). Held-out
 *  sealed entries never count — the gate cannot fire on evidence the dream
 *  must not see. */
export function dreamUnprocessedCount(entries: readonly MemoryEntry[], cursor: DreamCursor): number {
  return entries.filter((e) => (e.seq ?? 0) > cursor.lastSeq && !isHeldOutEntry(e)).length;
}

// ---------------------------------------------------------------------------
// The run (§3(d)-(g)) — fresh registry child + completion gate + audit.
// ---------------------------------------------------------------------------

/** Construction-enforced (§3(d)): the child's ENTIRE registry. runSubagent
 *  resolves exactly this pair (subagent.ts toolNames mapping) — no path-shaped
 *  tool, no shell, no task spawn can even be named. */
export const DREAM_TOOL_NAMES = ["memory_write", "memory_search"] as const;

export interface DreamOptions {
  readonly workspaceRoot: string;
  /** The session's model — the same choice the review fork makes (D2). */
  readonly model: ModelClient;
  /** The session's registry. A registry-less caller gets no dream (T8). */
  readonly registry?: AgentRegistry;
  /** Receives the 🧠 receipt line when the dream settles. */
  readonly onReceipt?: (line: string) => void;
}

export interface DreamSpawn {
  /** The registry's bg-N id. */
  readonly id: string;
  /** Resolves with the receipt line when the dream settles. */
  readonly done: Promise<string>;
}

/** One `<memoryDir>/dream.jsonl` line (D6): machine-derived — the child's
 *  report never enters the numbers (fromSeq/toSeq from the cursor, addedIds/
 *  auto/pending from the pre/post-spawn store id-diff). */
export interface DreamAuditRecord {
  readonly type: "dream_run";
  readonly at: string;
  readonly fromSeq: number;
  /** toSeq === fromSeq when the run aborted (the cursor never moved). */
  readonly toSeq: number;
  readonly ok: boolean;
  /** Registry error/abort reason (absent on ok). */
  readonly reason?: string;
  /** The rollback set — exactly the `/memory del` targets. */
  readonly addedIds: readonly string[];
  readonly auto: number;
  readonly pending: number;
}

/** ONE append per run. Never throws into the caller (skip-don't-corrupt). */
export async function appendDreamAudit(workspaceRoot: string, record: DreamAuditRecord): Promise<void> {
  const p = dreamAuditPath(workspaceRoot);
  await mkdir(dirname(p), { recursive: true });
  await appendFile(p, `${JSON.stringify(record)}\n`, "utf8");
}

/** Audit reads skip corrupt lines — a damaged dream.jsonl never aborts a run. */
export async function readDreamAudit(workspaceRoot: string): Promise<readonly DreamAuditRecord[]> {
  let text: string;
  try {
    text = await readFile(dreamAuditPath(workspaceRoot), "utf8");
  } catch {
    return [];
  }
  const out: DreamAuditRecord[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const r: unknown = JSON.parse(t);
      if (typeof r === "object" && r !== null && (r as { type?: unknown }).type === "dream_run") {
        out.push(r as DreamAuditRecord);
      }
    } catch {
      // skip a corrupt line rather than aborting the audit read
    }
  }
  return out;
}

// Module single-flight (§3(f)): the registry's 3 slots must never hold two
// dreams. Set synchronously in the attempt's prelude (before the first await)
// so two same-tick callers cannot both pass the gate; cleared on every early
// return and in the settle handler's finally.
let dreamInFlight = false;

/** The post-settle tail (§3(e)): diff → gate → cursor → audit → receipt. */
async function settleDream(
  opts: DreamOptions,
  store: ReturnType<typeof openSessionMemoryStore>,
  cursor: DreamCursor,
  built: DreamPrompt,
  before: ReadonlySet<string>,
  result: { readonly ok: boolean; readonly aborted?: boolean; readonly error?: string; readonly report: string },
): Promise<string> {
  // 1. Snapshot diff — machine-derived; the child's report never enters the
  //    numbers (the upstream project memory.py:747-762's rule).
  const added: MemoryEntry[] = [];
  try {
    for (const e of await store!.load()) {
      if (!before.has(e.id)) added.push(e);
    }
  } catch {
    // A broken re-read must not mask the receipt — report the run anyway.
  }
  const auto = added.filter((e) => e.status === "active").length;
  const pending = added.length - auto;
  const ok = result.ok === true;
  const reason = ok
    ? undefined
    : result.error ?? (result.aborted === true ? `aborted: ${result.report}` : result.report);
  const at = new Date().toISOString();

  // 2. Completion gate (D5: RegistryResult.ok) → the cursor moves ONLY
  //    through the captured batch, and only on ok (m1's invariant).
  if (ok) {
    await writeDreamCursor(opts.workspaceRoot, { lastSeq: built.lastSeq, lastRunAt: at, lastRunOk: true }).catch(() => {});
  } else {
    await writeDreamCursor(opts.workspaceRoot, { lastSeq: cursor.lastSeq, lastRunAt: at, lastRunOk: false }).catch(() => {});
  }

  // 3. Audit — ONE append to <memoryDir>/dream.jsonl (D6), diff-grounded.
  const record: DreamAuditRecord = {
    type: "dream_run",
    at,
    fromSeq: cursor.lastSeq,
    toSeq: ok ? built.lastSeq : cursor.lastSeq,
    ok,
    ...(reason !== undefined ? { reason } : {}),
    addedIds: added.map((e) => e.id),
    auto,
    pending,
  };
  await appendDreamAudit(opts.workspaceRoot, record).catch(() => {});

  // 4. Receipt — from the same diff, never the model's report (m3's invariant).
  // Design §3(e) step 4 verbatim: `consolidated <k> entries (added a, p
  // pending[, skipped <reason>])`.
  const k = added.length;
  const line = `🧠 dream: consolidated ${k} entr${k === 1 ? "y" : "ies"} (added ${auto}, ${pending} pending${ok ? "" : `, skipped ${reason}`})`;
  opts.onReceipt?.(line);
  return line;
}

async function startDream(opts: DreamOptions, manual: boolean): Promise<DreamSpawn | undefined> {
  if (dreamInFlight) return undefined; // single-flight
  if (!dreamEnabled()) return undefined; // kill switch (D7-style env)
  const registry = opts.registry;
  if (registry === undefined) return undefined; // registry-less caller (T8)
  const store = openSessionMemoryStore(opts.workspaceRoot);
  if (store === undefined) return undefined; // memoryEnabled:false (T8)
  dreamInFlight = true;
  let cursor: DreamCursor;
  let entries: readonly MemoryEntry[];
  let built: DreamPrompt | undefined;
  const before = new Set<string>();
  try {
    cursor = await readDreamCursor(opts.workspaceRoot);
    entries = await store.load();
    for (const e of entries) before.add(e.id);
    built = buildDreamPrompt({ entries, cursor });
  } catch {
    // Skip-don't-corrupt (§3(g)): an unreadable ledger never breaks anything.
    dreamInFlight = false;
    return undefined;
  }
  if (built === undefined) {
    dreamInFlight = false;
    return undefined; // nothing to consolidate
  }
  if (!manual && !dreamDue(cursor, dreamUnprocessedCount(entries, cursor), Date.now())) {
    dreamInFlight = false;
    return undefined;
  }
  let spawned;
  try {
    // The enforcement point is CONSTRUCTION (§3(d)): allTools is exactly the
    // memory pair and role.toolNames names exactly that pair, so
    // runSubagent's fresh-child resolution hands the child nothing else — no
    // path-shaped tool, no shell, no task spawn. Precedent: the review fork's
    // neutered set + the write-scope guard's construction-site rule.
    spawned = registry.spawn({
      model: opts.model,
      allTools: [createMemoryWriteTool(store), createMemorySearchTool(store)],
      role: {
        id: DREAM_ROLE_ID,
        description: "memory dream consolidation (ledger-only registry: memory_write + memory_search)",
        systemPrompt: DREAM_SYSTEM_PROMPT,
        toolNames: [...DREAM_TOOL_NAMES],
      },
      prompt: built.prompt,
      maxTurns: DREAM_MAX_TURNS,
      timeoutMs: DREAM_TIMEOUT_MS,
      graceTools: [],
      onSettle: () => {},
    });
  } catch {
    // A full registry (hard cap) or broken spawn must never break the run.
    dreamInFlight = false;
    return undefined;
  }
  const capturedBuilt = built;
  const capturedCursor = cursor;
  const done = spawned.done.then(async (result) => {
    try {
      return await settleDream(opts, store, capturedCursor, capturedBuilt, before, result);
    } catch (err) {
      // §3(g): any throw here degrades to the skip receipt — never rejects.
      const line = `🧠 dream: skipped (${err instanceof Error ? err.message : String(err)})`;
      opts.onReceipt?.(line);
      return line;
    } finally {
      dreamInFlight = false;
    }
  });
  return { id: spawned.id, done };
}

/** Spawn the dream through the session registry (fire-and-forget; the caller
 *  may await `done`). Due-gated (enabled + backlog + interval + single-flight);
 *  returns undefined when not due or disabled — never throws. */
export async function spawnDreamRun(opts: DreamOptions): Promise<DreamSpawn | undefined> {
  return startDream(opts, false);
}

/** The /memory dream verb (§3(f)): one consolidation NOW — bypasses ONLY the
 *  due-gates (never the kill switch, the completion gate, the audit, or the
 *  receipt). Returns the user-facing line. */
export async function runDreamVerb(opts: DreamOptions): Promise<string> {
  if (!dreamEnabled()) return "🧠 dream: disabled (WUDAO_DREAM=off or WUDAO_NO_DREAM_FORK=1)";
  if (opts.registry === undefined) return "🧠 dream: no agent registry in this session";
  if (dreamInFlight) return "🧠 dream: already in flight — its receipt lands when it settles";
  const spawn = await startDream(opts, true);
  if (spawn === undefined) return "(nothing to consolidate)";
  return spawn.done;
}
