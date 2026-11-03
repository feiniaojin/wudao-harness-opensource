// M55 §A1 — /init: guided AGENTS.md bootstrap. The model drives the scan
// with read-only tools (the plan-mode whitelist rides the /init run), then
// emits the draft inside <agents-md-draft> markers; the harness extracts it,
// shows a PREVIEW + confirm hint, and only the user's `ok` writes the file
// (the same review seam /plan uses). An existing AGENTS.md is never
// overwritten: the confirm appends a dated section instead.
import { truncateSafe } from "@wudao-org/core"; // 113-A4
import { existsSync } from "node:fs";
import { appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** The file /init bootstraps (the open-standard project-instructions name;
 *  project-context.ts loads it natively). */
export const AGENTS_MD = "AGENTS.md";

export const INIT_DRAFT_OPEN = "<agents-md-draft>";
export const INIT_DRAFT_CLOSE = "</agents-md-draft>";

/** The one-line hint printed under a fresh /init preview. */
export const INIT_REVIEW_HINT = 'draft ready — reply "ok" to write it · anything else stays a normal prompt (no write without confirmation)';

/** Preview cap: AGENTS.md drafts are typically 1-4KB; a runaway draft must
 *  not flood the history channel. */
export const INIT_PREVIEW_MAX_CHARS = 3_000;

/** The /init run's user message: scan contract + the draft envelope. */
export function buildInitPrompt(args: { readonly workspaceRoot: string; readonly hasExisting: boolean }): string {
  return [
    "<init-request>",
    "Bootstrap the project instructions file for this workspace (root: "
      + `${args.workspaceRoot}). This run is READ-ONLY — do not write, edit, or run anything; the harness writes the file after the user confirms.`,
    "",
    "Scan the codebase with the read-only tools, bounded (~12 reads max):",
    "1. glob the top-level structure (packages/src dirs, not node_modules)",
    "2. read README.md / package.json / other manifests (pyproject.toml, go.mod, Cargo.toml) if present",
    "3. sample a few key source files to recognize the stack and conventions",
    "",
    args.hasExisting
      ? "An AGENTS.md already exists. Draft ONLY a supplementary section the current file is missing (do not repeat existing content)."
      : "Draft the full file.",
    "Required sections (## headings):",
    "- Project overview — one short paragraph: what this repo is",
    "- Structure — the important directories and what lives in each",
    "- Stack — languages, runtimes, key dependencies",
    "- Conventions — code style, commit style, naming patterns you observed",
    "- Commands — build/test/run commands found in the manifests or scripts",
    "",
    "End your final answer with the draft inside these markers, nothing after them:",
    INIT_DRAFT_OPEN,
    "<the AGENTS.md content — markdown only, no outer code fence>",
    INIT_DRAFT_CLOSE,
    "</init-request>",
  ].join("\n");
}

/** The LAST <agents-md-draft>…</agents-md-draft> block in an answer, trimmed;
 *  undefined when absent or empty (the model did not follow the envelope). */
export function extractInitDraft(answer: string): string | undefined {
  const start = answer.lastIndexOf(INIT_DRAFT_OPEN);
  if (start === -1) return undefined;
  const contentStart = start + INIT_DRAFT_OPEN.length;
  const end = answer.indexOf(INIT_DRAFT_CLOSE, contentStart);
  const raw = (end === -1 ? answer.slice(contentStart) : answer.slice(contentStart, end)).trim();
  return raw === "" ? undefined : raw;
}

/** Whether AGENTS.md exists at the workspace root right now. */
export function hasExistingAgentsMd(workspaceRoot: string): boolean {
  return workspaceRoot !== "" && existsSync(join(workspaceRoot, AGENTS_MD));
}

/** The preview + confirm notice (the only thing that lands before the user
 *  answers — the file is still untouched). */
export function formatInitPreview(args: { readonly draft: string; readonly hasExisting: boolean }): string {
  const capped = args.draft.length > INIT_PREVIEW_MAX_CHARS
    ? `${truncateSafe(args.draft, INIT_PREVIEW_MAX_CHARS)}\n[… truncated — ${args.draft.length - INIT_PREVIEW_MAX_CHARS} more chars; the full draft is written on confirmation …]`
    : args.draft;
  const target = args.hasExisting
    ? `append a dated section to the existing ${AGENTS_MD} (never overwritten)`
    : `write ${AGENTS_MD} at the workspace root`;
  return [
    `${AGENTS_MD} draft — ${capped.split("\n").length} lines, ${args.draft.length} chars (confirm will ${target}):`,
    "---",
    capped,
    "---",
    INIT_REVIEW_HINT,
  ].join("\n");
}

export interface InitApplyOutcome {
  readonly path: string;
  /** true = appended a section to an existing file; false = wrote new. */
  readonly appended: boolean;
  readonly notice: string;
}

function ensureTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}

/** The post-confirmation write. Re-checks existence at write time: a file
 *  that appeared since the preview (or pre-existed) gets an APPEND with a
 *  dated separator, never an overwrite. */
export async function applyInitDraft(args: {
  readonly workspaceRoot: string;
  readonly draft: string;
  readonly now?: () => Date;
}): Promise<InitApplyOutcome> {
  const path = join(args.workspaceRoot, AGENTS_MD);
  const draft = ensureTrailingNewline(args.draft.trim());
  if (hasExistingAgentsMd(args.workspaceRoot)) {
    const stamp = (args.now ?? (() => new Date()))().toISOString().slice(0, 10);
    await appendFile(path, `\n\n---\n\n<!-- wudao /init ${stamp} -->\n\n${draft}`, "utf8");
    return { path, appended: true, notice: `↳ appended the /init section to the existing ${AGENTS_MD} (${draft.length} chars — restart to load it)` };
  }
  await writeFile(path, draft, "utf8");
  return { path, appended: false, notice: `↳ wrote ${AGENTS_MD} (${draft.length} chars — restart to load it as project context)` };
}
