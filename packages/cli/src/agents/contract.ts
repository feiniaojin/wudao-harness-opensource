// M30 — CLI-side orchestration contracts.
//
// The roster shapes, the registry surface, and the worktree results live in
// `@wudao/core` (re-exported through `core-bind.js`). What stays here is the
// CLI's OWN tool-surface vocabulary: the wire-form session parameter, the
// model-override seam, the orchestration tool names every child is denied,
// and the two pure roster helpers the task tool applies on top of core
// (default tool set + the no-nested-orchestration filter).
import type { AgentRoleProfile, LoadedRoster } from "@wudao/core";
import { KERNEL_POLICY } from "../kernel-policy.js";

// ---------------------------------------------------------------------------
// Roster helpers (over core's profiles)
// ---------------------------------------------------------------------------

/** Resolve a role by id. Core's loader already layers builtins under
 *  workspace files, so the roster map IS the resolution — the helper keeps
 *  the lookup named at the call sites. Unknown → undefined. */
export function resolveRole(roster: LoadedRoster, id: string): AgentRoleProfile | undefined {
  return roster.profiles.get(id);
}

/** Effective tool list for a child: the profile's toolNames (default
 *  read-only set) minus the orchestration tools — the fail-closed guard that
 *  keeps children from spawning children. */
export function roleToolNames(profile: AgentRoleProfile, exclude: readonly string[]): readonly string[] {
  const names = profile.toolNames ?? DEFAULT_ROLE_TOOLS;
  return names.filter((n) => !exclude.includes(n));
}

// ---------------------------------------------------------------------------
// Child sessions (spec §C) — the wire form is a compact string so the tool
// schema stays within the primitive parameter types; both string and object
// forms are accepted at execute time.
// ---------------------------------------------------------------------------

export interface AgentSessionRef {
  readonly mode: "new" | "resume" | "fork";
  readonly id?: string;
}

export type SessionParse =
  | { readonly ok: true; readonly session: AgentSessionRef }
  | { readonly ok: false; readonly error: string };

const SESSION_MODES: readonly string[] = ["new", "resume", "fork"];

/** Parse the task tool's `session` argument. Accepts `"new"`, `"resume:<id>"`,
 *  `"fork:<id>"`, or a JSON object `{"mode":"resume","id":"..."}`. Fail-closed:
 *  resume/fork without an id is an error (there is nothing to resume). */
export function parseSessionParam(raw: unknown): SessionParse {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    const colon = trimmed.indexOf(":");
    const head = (colon === -1 ? trimmed : trimmed.slice(0, colon)).toLowerCase();
    if (!SESSION_MODES.includes(head)) {
      return { ok: false, error: `session must be "new", "resume:<id>", "fork:<id>", or a JSON object (got ${JSON.stringify(trimmed)})` };
    }
    const mode = head as AgentSessionRef["mode"];
    const id = colon === -1 ? undefined : trimmed.slice(colon + 1).trim() || undefined;
    return check({ mode, ...(id !== undefined ? { id } : {}) });
  }
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    const rec = raw as Record<string, unknown>;
    const mode = typeof rec.mode === "string" ? rec.mode.toLowerCase() : "";
    if (!SESSION_MODES.includes(mode)) {
      return { ok: false, error: `session.mode must be one of new|resume|fork (got ${JSON.stringify(rec.mode ?? null)})` };
    }
    const id = typeof rec.id === "string" && rec.id.trim() !== "" ? rec.id.trim() : undefined;
    return check({ mode: mode as AgentSessionRef["mode"], ...(id !== undefined ? { id } : {}) });
  }
  return { ok: false, error: "session must be \"new\", \"resume:<id>\", \"fork:<id>\", or a JSON object" };
}

function check(session: AgentSessionRef): SessionParse {
  if ((session.mode === "resume" || session.mode === "fork") && session.id === undefined) {
    return { ok: false, error: `session mode "${session.mode}" requires an id (resume:<id> / fork:<id>)` };
  }
  return { ok: true, session };
}

// ---------------------------------------------------------------------------
// Model overrides + resolution seam (spec §A: frozen roles must reject these)
// ---------------------------------------------------------------------------

export interface ModelOverrides {
  readonly provider?: string;
  readonly model?: string;
  readonly reasoningEffort?: string;
}

export type ModelResolution =
  | { readonly ok: true; readonly model: import("@wudao/core").ModelClient; readonly effectiveEffort: string }
  | { readonly ok: false; readonly error: string };

export function hasOverrides(o: ModelOverrides | undefined): boolean {
  return o !== undefined && (o.provider !== undefined || o.model !== undefined || o.reasoningEffort !== undefined);
}

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

/** Tools that never enter a child agent's tool set — nested orchestration is
 *  refused, not nested (fail-closed even when a workspace role lists them). */
export const ORCHESTRATION_TOOL_NAMES: readonly string[] = ["task", "agent_await", "agent_status", "agent_cancel", "ask_user"];

/** Default child tool set when a profile declares no `toolNames`. */
/** M49 §1: memory_search joins the default read-only child set (children
 *  search memory, never write it — memory_write is top-level only). A role
 *  listing it in a workspace without a memory store just misses the name. */
export const DEFAULT_ROLE_TOOLS: readonly string[] = ["read_file", "glob", "grep", "memory_search"];

/** Registry concurrency: default 3, hard ceiling 16 (spec §B). M41: the
 *  values live in kernel-policy.ts (the single policy source) — these
 *  aliases keep the historical import surface. */
export const DEFAULT_MAX_CONCURRENT = KERNEL_POLICY.registry.maxConcurrent;
export const HARD_MAX_CONCURRENT = KERNEL_POLICY.registry.maxConcurrentCeiling;
