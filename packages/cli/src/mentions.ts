// M34 §2 — @-mentions: expand `@<relative path>` in user input BEFORE it
// enters the conversation. One shared helper for all three frontends (TUI
// submit, REPL prompt, one-shot argv prompt). The expansion is an append-only
// rewrite of the prompt text itself: the model sees the file's read window
// wrapped in <file path="…">…</file>, the session history stores exactly what
// was sent (KV: append semantics — naturally cache-safe).
//
// Constraints (read_file's, verbatim): workspace confinement via
// resolveWorkspacePath + the 2000-line/50KB window. Missing files keep the
// token as written + a dim notice; the same file expands ONCE (later tokens
// stay literal); no glob support (a glob pattern is simply not a file).
import { readFile } from "node:fs/promises";
import { resolveWorkspacePath, readTextWindow } from "@wudao/core";

/** What expandMentions produced: the rewritten text + human-facing dim
 *  notices (missing file, workspace escape). Notices never enter the
 *  conversation — the frontends print them. */
export interface MentionExpansion {
  readonly text: string;
  readonly notices: readonly string[];
}

// A mention starts at a word boundary (start of text or after whitespace) and
// runs to the next whitespace/@ — no spaces, no nesting. `a@b.com` and `@@x`
// therefore do not mention anything.
const MENTION_RE = /(^|\s)@([^\s@]+)/g;

/** All mention tokens in order of appearance (duplicates included). */
export function findMentionTokens(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(MENTION_RE)) {
    const token = m[2];
    if (token !== undefined) out.push(token);
  }
  return out;
}

/** Wrap one file's read window in the mention envelope. One trailing newline
 *  of the window is dropped so a file ending in \n doesn't produce a blank
 *  line before </file> (the envelope provides its own final newline). */
function mentionBlock(token: string, content: string): string {
  const window = readTextWindow(content).replace(/\n$/, "");
  return `<file path="${token}">\n${window}\n</file>`;
}

/** Expand every @-mention in `input` against `workspaceRoot`. Never throws:
 *  unreadable tokens keep their literal text and produce a notice. */
export async function expandMentions(input: string, workspaceRoot: string): Promise<MentionExpansion> {
  const tokens = findMentionTokens(input);
  if (tokens.length === 0) return { text: input, notices: [] };

  // Unique tokens in first-appearance order; read each once.
  const unique: string[] = [];
  for (const t of tokens) if (!unique.includes(t)) unique.push(t);

  const expanded = new Map<string, string>();
  const notices: string[] = [];
  for (const token of unique) {
    const resolved = await resolveWorkspacePath(workspaceRoot, token);
    if (!resolved.ok) {
      notices.push(`⚠️ @${token} ${resolved.error} — left as written`);
      continue;
    }
    try {
      const content = await readFile(resolved.absPath, "utf8");
      expanded.set(token, mentionBlock(token, content));
    } catch {
      notices.push(`⚠️ @${token} not found — left as written`);
    }
  }
  if (expanded.size === 0) return { text: input, notices };

  // Replace the FIRST occurrence of each expandable token; duplicates and
  // failures keep their literal text (the first expansion already carries
  // the content — repeating it would double the context).
  const seen = new Set<string>();
  const text = input.replace(MENTION_RE, (whole, lead: string, token: string) => {
    const block = expanded.get(token);
    if (block === undefined || seen.has(token)) return whole;
    seen.add(token);
    return `${lead}${block}`;
  });
  return { text, notices };
}
