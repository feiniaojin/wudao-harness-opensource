// M58 §C#10 — cross-session prompt history. Every submitted prompt appends
// `{text, project, ts}` to <WUDAO_GLOBAL_HOME>/history.jsonl (one file for
// every project); TUI/REPL startup preloads the up-arrow history with the
// CURRENT project's entries (newest last). Rotation: past 10000 lines the
// file is atomically rewritten (tmp + rename) keeping the most recent 5000.
// The ts is Date.now() at submit — this is product code; a wall-clock
// timestamp is the point (only workflow scripts pin deterministic clocks).
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolveGlobalHome } from "./settings-layer.js";
import { INPUT_HISTORY_MAX } from "./tui/input-state.js";

/** Rotate when the file exceeds this many lines (spec: 1 万行). */
export const HISTORY_ROTATE_ABOVE_LINES = 10_000;
/** Keep this many most-recent lines on rotation (spec: 截半). */
export const HISTORY_ROTATE_KEEP_LINES = 5_000;

/** The history file under the resolved global home (test-isolated via
 *  WUDAO_GLOBAL_HOME). */
export function promptHistoryPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveGlobalHome(env), "history.jsonl");
}

/** One parsed history line. */
export interface PromptHistoryEntry {
  readonly text: string;
  readonly project: string;
  readonly ts: number;
}

function parseLine(line: string): PromptHistoryEntry | undefined {
  const trimmed = line.trim();
  if (trimmed === "") return undefined;
  try {
    const parsed = JSON.parse(trimmed) as Partial<PromptHistoryEntry>;
    if (typeof parsed.text !== "string" || parsed.text === "") return undefined;
    if (typeof parsed.project !== "string") return undefined;
    return { text: parsed.text, project: parsed.project, ts: typeof parsed.ts === "number" ? parsed.ts : 0 };
  } catch {
    return undefined; // a corrupt line never breaks recall
  }
}

function readLines(content: string): readonly PromptHistoryEntry[] {
  const out: PromptHistoryEntry[] = [];
  for (const line of content.split("\n")) {
    const parsed = parseLine(line);
    if (parsed !== undefined) out.push(parsed);
  }
  return out;
}

/** Append one submitted prompt for `project` (empty/whitespace text is not a
 *  prompt — nothing is recorded). Fire-and-forget safe: failures are the
 *  caller's to ignore (history must never break a submit). After the append,
 *  rotate when over the cap (atomic rewrite keeping the newest half). */
export async function appendPromptHistory(
  text: string,
  project: string,
  opts: { readonly env?: NodeJS.ProcessEnv; readonly now?: number } = {},
): Promise<void> {
  if (text.trim() === "") return;
  const path = promptHistoryPath(opts.env);
  const entry: PromptHistoryEntry = { text, project, ts: opts.now ?? Date.now() };
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(entry)}\n`, "utf8");
  // Rotation: read-back and count. Single-user CLI assumption — a concurrent
  // rotate from two processes may drop one racing line, never corrupt.
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch {
    return;
  }
  const lines = content.split("\n").filter((l) => l.trim() !== "");
  if (lines.length <= HISTORY_ROTATE_ABOVE_LINES) return;
  const kept = lines.slice(-HISTORY_ROTATE_KEEP_LINES);
  const tmp = `${path}.tmp`;
  await writeFile(tmp, kept.map((l) => `${l}\n`).join(""), "utf8");
  await rename(tmp, path);
}

/** The current project's prompts, oldest→newest (newest last = the up-arrow
 *  walk direction), adjacent-duplicate collapsed, capped at the input
 *  history max. A missing file / foreign-project entries → []. */
export async function loadPromptHistory(
  project: string,
  opts: { readonly env?: NodeJS.ProcessEnv; readonly max?: number } = {},
): Promise<readonly string[]> {
  let content: string;
  try {
    content = await readFile(promptHistoryPath(opts.env), "utf8");
  } catch {
    return [];
  }
  const texts: string[] = [];
  for (const e of readLines(content)) {
    if (e.project !== project) continue;
    if (texts[texts.length - 1] === e.text) continue; // adjacent dedup (recall UX)
    texts.push(e.text);
  }
  const max = opts.max ?? INPUT_HISTORY_MAX;
  return texts.length > max ? texts.slice(texts.length - max) : texts;
}
