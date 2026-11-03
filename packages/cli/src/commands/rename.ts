// M55 §A4 — /rename <name>: rewrite the current session's name. The store is
// append-only, so a rename APPENDS a new `session_name` entry — the reader
// (sessionName() in session-list.ts) takes the LAST one, which is exactly the
// rewrite semantics the /resume picker and `--list-sessions` render. Nothing
// is deleted; the history of names stays auditable in the JSONL.
import { join } from "node:path";
import { createJsonlSessionStore } from "@wudao-org/core";

/** Same bound as a derived name (session-list NAME_MAX_CHARS). */
export const SESSION_NAME_MAX_CHARS = 48;

export type RenameValidation = { readonly ok: true; readonly name: string } | { readonly ok: false; readonly error: string };

/** Validate an explicit user-chosen name: trimmed, non-empty, single line,
 *  ≤48 chars (the derived-name bound — the picker column assumes it). */
export function validateSessionName(raw: string): RenameValidation {
  const name = raw.trim();
  if (name === "") return { ok: false, error: "用法：/rename <name>——名称不能为空" }; // ω99-166d-i: #22
  if (name.length > SESSION_NAME_MAX_CHARS) {
    return { ok: false, error: `name too long (${name.length} chars; max ${SESSION_NAME_MAX_CHARS})` };
  }
  if (/[\r\n]/.test(name)) return { ok: false, error: "the name must be a single line" };
  return { ok: true, name };
}

export interface RenameOutcome {
  readonly name: string;
  /** The human-facing notice line (frontends print/append it). */
  readonly notice: string;
}

/** Append the session_name entry (appendSessionEntry pattern: the store stays
 *  append-only, the last entry wins on read). */
export async function renameSession(args: {
  readonly workspaceRoot: string;
  readonly sessionId: string;
  readonly name: string;
}): Promise<RenameOutcome> {
  const store = createJsonlSessionStore(join(args.workspaceRoot, ".wudao", "sessions"));
  // 夜移 005: manual tag — auto-titling reads it and never overwrites the user.
  await store.appendEntry(args.sessionId, { type: "session_name", name: args.name, source: "manual" });
  return {
    name: args.name,
    notice: `renamed session ${args.sessionId.slice(0, 8)} → "${args.name}" (/resume and /search show the new name)`,
  };
}
