// P2-13 (96 队列 #13) — the USER CONSTITUTION store: the three-file
// user-global layer under ~/.wudao/ (WUDAO_GLOBAL_HOME-sandboxed like every
// global-tier file, so tests isolate without touching the operator's store).
// CodeWhale crates/config/src/user_constitution.rs lineage:
//   • constitution.md     — the ONLY active file. Written EXCLUSIVELY by
//     approvePendingClause (atomic tmp+rename) — the model-side tool has no
//     code path that reaches it (the suggest tool writes the pending dir
//     only, hardcoded, zero path parameters). A hand-edited active file
//     drifts from the manifest digest and reads STALE: fail-closed, the
//     content is NOT adopted, the user is pointed back to /constitution.
//   • constitution-pending/ — the suggestion inbox, one .md per clause,
//     sequence-named (0001.md, 0002.md, …). Cap 50; single clause ≤2000
//     chars (validated BEFORE any side effect).
//   • constitution.json   — the manifest: the approved clauses' digest array
//     + timestamps (append-tendency audit trail) and the ACTIVE FILE's
//     whole-content digest — the drift detector's basis.
// Governance is USER-level, never project-level (the settings-layer trust
// gate drops any project-tier `constitution` key with a warning).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveGlobalHome } from "../settings-layer.js";

/** Single-clause cap (chars). Enforced in the store AND the tool —
 * validation before side effects, fail-closed. */
export const CONSTITUTION_CLAUSE_MAX_CHARS = 2_000;

/** Pending-inbox cap: full refuses new suggestions (never overflows). */
export const CONSTITUTION_PENDING_CAP = 50;

/** The three files' home (display form; resolved via resolveGlobalHome). */
export const CONSTITUTION_DISPLAY_DIR = "~/.wudao";

export interface ConstitutionPaths {
  /** The active constitution — approve-only (atomic writes). */
  readonly active: string;
  /** The suggestion inbox directory (one .md per clause, sequence-named). */
  readonly pendingDir: string;
  /** The manifest (approved digests + timestamps + the file digest). */
  readonly manifest: string;
}

export function constitutionPaths(env: NodeJS.ProcessEnv = process.env): ConstitutionPaths {
  const root = resolveGlobalHome(env);
  return {
    active: join(root, "constitution.md"),
    pendingDir: join(root, "constitution-pending"),
    manifest: join(root, "constitution.json"),
  };
}

/** sha256 hex of a utf8 string (node:crypto — zero new dependencies). */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Pending inbox
// ---------------------------------------------------------------------------

export interface PendingSuggestion {
  /** The 1-based sequence number (the file's numeric stem — /constitution's
   * approve/reject argument). */
  readonly n: number;
  /** Basename, e.g. "0003.md" (the tool receipt quotes it). */
  readonly file: string;
  /** The clause text (trimmed). */
  readonly content: string;
}

const PENDING_NAME_RE = /^(\d+)\.md$/;

/** All pending suggestions in sequence order. Missing dir → []. */
export function listPending(env: NodeJS.ProcessEnv = process.env): readonly PendingSuggestion[] {
  const dir = constitutionPaths(env).pendingDir;
  let names: readonly string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const items: PendingSuggestion[] = [];
  for (const name of names) {
    const m = PENDING_NAME_RE.exec(name);
    if (m === null) continue; // not ours — ignore
    let content = "";
    try {
      content = readFileSync(join(dir, name), "utf8");
    } catch {
      continue; // raced away — skip
    }
    items.push({ n: Number(m[1]), file: name, content: content.trim() });
  }
  return items.sort((a, b) => a.n - b.n);
}

/** Validate one clause BEFORE any side effect (fail-closed; both the tool
 * and the store call this — defense in depth). Returns the normalized
 * clause or throws with a clear message. */
export function validateClause(clause: string): string {
  const trimmed = clause.trim();
  if (trimmed === "") {
    throw new Error(`constitution clause must be a non-empty string (≤${CONSTITUTION_CLAUSE_MAX_CHARS} chars)`);
  }
  if (trimmed.length > CONSTITUTION_CLAUSE_MAX_CHARS) {
    throw new Error(
      `constitution clause is ${trimmed.length} chars — over the ${CONSTITUTION_CLAUSE_MAX_CHARS}-char cap`,
    );
  }
  return trimmed;
}

/** Queue one suggestion into the pending inbox (the ONLY write the model
 * side can ever trigger). Sequence-named and MONOTONIC: the next number is
 * max(pending inbox, the manifest's already-consumed `from` numbers) + 1 —
 * a number is never reused, so the manifest's audit trail stays unambiguous
 * even after approvals consume their pending files. Capped, validated
 * first. Returns the receipt (file name + new count). */
export function appendPendingSuggestion(
  clause: string,
  env: NodeJS.ProcessEnv = process.env,
): { file: string; pendingCount: number } {
  const normalized = validateClause(clause);
  const dir = constitutionPaths(env).pendingDir;
  const existing = listPending(env);
  if (existing.length >= CONSTITUTION_PENDING_CAP) {
    throw new Error(
      `constitution pending inbox full (${CONSTITUTION_PENDING_CAP}) — the user must approve or reject items via /constitution first`,
    );
  }
  let maxSeen = existing.length === 0 ? 0 : existing[existing.length - 1]!.n;
  const manifest = readManifest(env);
  if (manifest !== undefined) {
    for (const c of manifest.clauses) {
      const m = PENDING_NAME_RE.exec(c.from);
      if (m !== null) maxSeen = Math.max(maxSeen, Number(m[1]));
    }
  }
  const next = maxSeen + 1;
  const file = `${String(next).padStart(4, "0")}.md`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), `${normalized}\n`, "utf8");
  return { file, pendingCount: existing.length + 1 };
}

// ---------------------------------------------------------------------------
// Manifest — approved digests (audit) + the active-file digest (drift basis)
// ---------------------------------------------------------------------------

export interface ManifestClause {
  /** sha256 of the clause text alone (audit trail; append-tendency). */
  readonly digest: string;
  readonly approvedAt: string;
  /** The pending file the clause came from (e.g. "0001.md"). */
  readonly from: string;
}

export interface ConstitutionManifest {
  readonly version: 1;
  /** Approved clauses in approval order — the array only ever GROWS. */
  readonly clauses: readonly ManifestClause[];
  /** sha256 of the ACTIVE FILE's full content — the staleness check. */
  readonly digest: string;
  readonly updatedAt: string;
}

/** Read the manifest. Missing → undefined. Corrupt/malformed → undefined +
 * one warning (fail-closed: any active file then reads STALE, never
 * adopted). Never throws. */
export function readManifest(
  env: NodeJS.ProcessEnv = process.env,
  warn: (m: string) => void = () => {},
): ConstitutionManifest | undefined {
  let text: string;
  try {
    text = readFileSync(constitutionPaths(env).manifest, "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    const m = parsed as Record<string, unknown>;
    if (typeof m.digest !== "string" || !Array.isArray(m.clauses)) throw new Error("bad shape");
    const clauses = (m.clauses as unknown[]).map((c) => {
      if (c === null || typeof c !== "object") throw new Error("bad clause");
      const e = c as Record<string, unknown>;
      if (typeof e.digest !== "string" || typeof e.approvedAt !== "string" || typeof e.from !== "string") {
        throw new Error("bad clause");
      }
      return { digest: e.digest, approvedAt: e.approvedAt, from: e.from };
    });
    return {
      version: 1,
      clauses,
      digest: m.digest,
      updatedAt: typeof m.updatedAt === "string" ? m.updatedAt : "",
    };
  } catch (err) {
    warn(
      `⚠️ ${constitutionPaths(env).manifest} is not a valid constitution manifest (${err instanceof Error ? err.message : String(err)}) — the active constitution reads as unapproved until re-approved`,
    );
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Active file — read + approve (the ONLY writer)
// ---------------------------------------------------------------------------

export interface ActiveConstitution {
  readonly content: string;
  /** sha256 of content AS ON DISK (the rendered digest). */
  readonly digest: string;
  /** The manifest's recorded file digest (undefined = no manifest). */
  readonly manifestDigest: string | undefined;
  /** Approved clause count from the manifest (0 when no manifest). */
  readonly clauseCount: number;
  /** manifestDigest !== digest (or no manifest at all): hand-edited or
   * never approved — NEVER silently adopted. */
  readonly stale: boolean;
}

export interface ConstitutionStatus {
  readonly active: ActiveConstitution | undefined;
  readonly pending: readonly PendingSuggestion[];
}

/** The full status: the active file (with the staleness verdict) + the
 * pending inbox. Never throws. */
export function constitutionStatus(
  env: NodeJS.ProcessEnv = process.env,
  warn: (m: string) => void = () => {},
): ConstitutionStatus {
  const pending = listPending(env);
  let content: string;
  try {
    content = readFileSync(constitutionPaths(env).active, "utf8");
  } catch {
    return { active: undefined, pending };
  }
  const digest = sha256Hex(content);
  const manifest = readManifest(env, warn);
  return {
    active: {
      content,
      digest,
      manifestDigest: manifest?.digest,
      clauseCount: manifest?.clauses.length ?? 0,
      stale: manifest === undefined || manifest.digest !== digest,
    },
    pending,
  };
}

/** The approve verb (the /constitution face calls this — the model has no
 * path here). Appends pending n's clause into the active file ATOMICALLY
 * (tmp+rename), records both digests in the manifest (also atomic), then
 * consumes the pending file. Throws with a clear message on any missing
 * piece — the command face renders it, nothing half-written lands. */
export function approvePendingClause(
  n: number,
  env: NodeJS.ProcessEnv = process.env,
): { content: string; digest: string; clauseCount: number } {
  const paths = constitutionPaths(env);
  const item = listPending(env).find((p) => p.n === n);
  if (item === undefined) {
    throw new Error(`no pending constitution suggestion ${n} — /constitution lists the inbox`);
  }
  const clause = validateClause(item.content);
  let current = "";
  try {
    current = readFileSync(paths.active, "utf8");
  } catch {
    /* first clause — the file starts empty */
  }
  // Canonical join: clauses separated by ONE blank line, file ends with \n.
  const base = current.replace(/\n+$/, "");
  const nextContent = base === "" ? `${clause}\n` : `${base}\n\n${clause}\n`;

  const manifest = readManifest(env);
  const nextManifest: ConstitutionManifest = {
    version: 1,
    clauses: [
      ...(manifest?.clauses ?? []),
      { digest: sha256Hex(clause), approvedAt: new Date().toISOString(), from: item.file },
    ],
    digest: sha256Hex(nextContent),
    updatedAt: new Date().toISOString(),
  };

  // Active file: atomic write (tmp + rename), dir on demand.
  mkdirSync(paths.pendingDir, { recursive: true }); // implies the global home exists too
  const tmpActive = `${paths.active}.tmp-${process.pid}`;
  writeFileSync(tmpActive, nextContent, "utf8");
  renameSync(tmpActive, paths.active);
  // Manifest: atomic write beside it.
  const tmpManifest = `${paths.manifest}.tmp-${process.pid}`;
  writeFileSync(tmpManifest, `${JSON.stringify(nextManifest, null, 2)}\n`, "utf8");
  renameSync(tmpManifest, paths.manifest);
  // The pending item is consumed (it IS the approved content now).
  rmSync(join(paths.pendingDir, item.file), { force: true });
  return { content: nextContent, digest: nextManifest.digest, clauseCount: nextManifest.clauses.length };
}

/** The reject verb: drop pending n. Returns the remaining count. */
export function rejectPendingClause(
  n: number,
  env: NodeJS.ProcessEnv = process.env,
): { pendingCount: number } {
  const paths = constitutionPaths(env);
  const item = listPending(env).find((p) => p.n === n);
  if (item === undefined) {
    throw new Error(`no pending constitution suggestion ${n} — /constitution lists the inbox`);
  }
  rmSync(join(paths.pendingDir, item.file), { force: true });
  return { pendingCount: listPending(env).length };
}

/** True when the active file exists (status rendering convenience). */
export function hasActiveConstitution(env: NodeJS.ProcessEnv = process.env): boolean {
  return existsSync(constitutionPaths(env).active);
}
