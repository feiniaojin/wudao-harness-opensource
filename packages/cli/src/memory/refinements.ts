// ω99-3a — the /refine audit trail: append-only `.wudao/memory-refinements.jsonl`
// (same directory as memory.jsonl — it follows the store, honoring
// memoryDirectory overrides). ONE line per refine (and one per rollback),
// carrying the before/after snapshots the rollback path replays backwards.
// Kept OUT of store.ts (already 300+ lines); the store imports this module,
// and this module needs only the MemoryKind TYPE from store.ts (type-only —
// erased at runtime, so the cycle never exists on the wire).
// Design: omega-3-design-notes.md ω-3a — update/rollback are EXPLICIT verbs
// (never part of Dream's additions-only flow), and every refine is audited
// with machine-derived snapshots (taken from store return values, never the
// model's self-report — the dream D6 discipline).
import { mkdir, readFile, appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { MemoryKind } from "./store.js";
import { memoryDirectory } from "./store.js";

/** One edit as RECORDED (what actually happened, with snapshots from the
 *  store's return values). For create: `id` is the store-minted id of the
 *  created entry (rollback needs it to reverse create→remove); `after` is
 *  the entry as written. For update: `before`/`after` bracket the version
 *  bump. For delete: only `before` — the suggestion NEVER executed (the
 *  user runs /memory del themselves), so there is no after state of ours. */
export interface RefineEdit {
  readonly action: "create" | "update" | "delete";
  readonly id?: string;
  readonly kind?: MemoryKind;
  readonly before?: { readonly content: string; readonly version: number; readonly status: string };
  readonly after?: { readonly content: string; readonly version: number; readonly status: string };
}

/** One `.wudao/memory-refinements.jsonl` line. `trigger` is "manual" only in
 *  this batch (ω-3b would add "auto" for the auto-refine gate). `outcome`
 *  "rejected" marks a proposal that failed validation — audited, never
 *  applied (the trail must show the ask even when the answer was no). */
export interface RefinementAuditLine {
  readonly refineId: string; // "rf-" + 8 hex random
  readonly at: string; // ISO
  readonly trigger: "manual";
  readonly summary: string;
  readonly rationale: string;
  readonly expectedOutcome: string;
  readonly edits: readonly RefineEdit[];
  readonly outcome: "applied" | "rejected";
}

/** The audit path for a STORE PATH (the low-level form): always beside the
 *  ledger that was edited — a session-configured memoryDirectory is honored
 *  for free because the store handle already lives there. */
export function refinementsPathFor(storePath: string): string {
  return join(dirname(storePath), "memory-refinements.jsonl");
}

/** The audit path for a workspace root (the dream-cursor style convenience:
 *  follows the session's memoryDirectory when set, else <root>/.wudao). */
export function refinementsPath(workspaceRoot: string): string {
  return join(memoryDirectory(workspaceRoot), "memory-refinements.jsonl");
}

/** Parse-and-validate one line (refineId must be a string, edits an array —
 *  anything else is a corrupt line, skipped by the reader like dream.jsonl). */
function parseAuditLine(raw: unknown): RefinementAuditLine | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.refineId !== "string" || r.refineId === "") return undefined;
  if (!Array.isArray(r.edits)) return undefined;
  return {
    refineId: r.refineId,
    at: typeof r.at === "string" ? r.at : "",
    trigger: "manual",
    summary: typeof r.summary === "string" ? r.summary : "",
    rationale: typeof r.rationale === "string" ? r.rationale : "",
    expectedOutcome: typeof r.expectedOutcome === "string" ? r.expectedOutcome : "",
    edits: r.edits.filter((e): e is RefineEdit => typeof e === "object" && e !== null),
    outcome: r.outcome === "rejected" ? "rejected" : "applied",
  };
}

/** Append ONE audit line at `auditPath`. Never throws into the refine flow —
 *  a failed audit append is logged by the caller's receipt path, not by
 *  crashing the command (skip-don't-corrupt, dream §3(g)). */
async function appendRefinementAuditFile(auditPath: string, line: RefinementAuditLine): Promise<void> {
  await mkdir(dirname(auditPath), { recursive: true });
  await appendFile(auditPath, `${JSON.stringify(line)}\n`, "utf8");
}

/** Append beside the store at `storePath` (the apply/rollback path — always
 *  beside the ledger that was actually edited). */
export async function appendRefinementAuditAt(storePath: string, line: RefinementAuditLine): Promise<void> {
  await appendRefinementAuditFile(refinementsPathFor(storePath), line);
}

/** Read the audit at `auditPath` (file order; corrupt lines skipped). An
 *  absent file is an empty trail. */
async function readRefinementAuditFile(auditPath: string): Promise<readonly RefinementAuditLine[]> {
  let text: string;
  try {
    text = await readFile(auditPath, "utf8");
  } catch {
    return [];
  }
  const out: RefinementAuditLine[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const parsed = parseAuditLine(JSON.parse(t));
      if (parsed) out.push(parsed);
    } catch {
      // skip a corrupt line rather than aborting the audit read
    }
  }
  return out;
}

/** Read beside the store at `storePath` (the rollback path's view). */
export async function readRefinementAuditAt(storePath: string): Promise<readonly RefinementAuditLine[]> {
  return readRefinementAuditFile(refinementsPathFor(storePath));
}

// Workspace-root conveniences (session-aware directory via refinementsPath,
// dream-cursor style). In a process with no session override these resolve to
// exactly the store-path form for <root>/.wudao/memory.jsonl — the two views
// agree wherever the default store is in play (tests, plain REPL without a
// memoryDirectory setting).
export async function appendRefinementAudit(workspaceRoot: string, line: RefinementAuditLine): Promise<void> {
  await appendRefinementAuditFile(refinementsPath(workspaceRoot), line);
}

export async function readRefinementAudit(workspaceRoot: string): Promise<readonly RefinementAuditLine[]> {
  return readRefinementAuditFile(refinementsPath(workspaceRoot));
}
