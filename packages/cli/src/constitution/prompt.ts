// P2-13 (96 队列 #13) — the constitution SYSTEM-PROMPT SECTION: the active
// constitution rendered into the memoized stable tail, MCP-section style.
//
// Cache discipline (the MCP/project-context seam, copied verbatim in spirit):
// the section is loaded ONCE per process (memoized in getConstitutionSection)
// and its bytes NEVER shift mid-session — editing constitution.md (or
// approving a clause) requires a RESTART to take effect, because re-reading
// would shift the system-prompt prefix and break the provider prefix cache.
// No active constitution (or a STALE one — digest mismatch, fail-closed, not
// silently adopted) → "" → the prompt stays byte-identical to the
// pre-P2-13 baseline (pinned by tests).
import { constitutionStatus } from "./store.js";

/** Heading of the injected section (unique — /context picks sections up by
 * their `#`/`##` headings). */
export const CONSTITUTION_HEADING = "# User constitution";

export interface ConstitutionSection {
  /** The ready-to-append section; "" when absent/stale (byte-identical
   * baseline). */
  readonly section: string;
  /** Non-fatal problems (the stale-digest notice) for startup warnings. */
  readonly notices: readonly string[];
  /** The active file's sha256 (undefined when no section rendered). */
  readonly digest: string | undefined;
}

/** Load the section from disk (pure w.r.t. the filesystem at call time —
 * callers wanting the session-static behavior go through
 * getConstitutionSection). Stale = digest mismatch → section DROPPED + a
 * notice (fail-closed: hand-edited content is never silently adopted, the
 * user is pointed back to /constitution; not fatal). */
export function loadConstitutionSection(env: NodeJS.ProcessEnv = process.env): ConstitutionSection {
  const status = constitutionStatus(env);
  if (status.active === undefined) return { section: "", notices: [], digest: undefined };
  if (status.active.stale) {
    return {
      section: "",
      notices: [
        "constitution.md does not match the approved digest (edited outside /constitution?) — the constitution section is NOT loaded; restore the file or re-approve the change via /constitution, then restart",
      ],
      digest: undefined,
    };
  }
  const { content, digest } = status.active;
  const section =
    `\n\n${CONSTITUTION_HEADING}\n` +
    `Clauses the operator ratified via /constitution (digest sha256:${digest}). ` +
    `They bind every session until amended through /constitution.\n` +
    content;
  return { section, notices: [], digest };
}

// Session-static access: memoized once per process (no hot reload — restart
// to pick up approvals; the bytes never shift mid-session, prefix-cache law).
let cached: string | undefined;

/** The memoized constitution section for the CURRENT process env ("" when
 * absent/stale). Notices print ONCE, on the first (loading) call — the
 * project-context loader's convention. */
export function getConstitutionSection(): string {
  if (cached !== undefined) return cached;
  const loaded = loadConstitutionSection(process.env);
  for (const n of loaded.notices) console.warn(`[wudao] constitution: ${n}`);
  cached = loaded.section;
  return cached;
}

/** Tests only: drop the memo so a fresh load observes the fixture files
 * (simulates the restart that a real session needs). */
export function resetConstitutionCacheForTests(): void {
  cached = undefined;
}
