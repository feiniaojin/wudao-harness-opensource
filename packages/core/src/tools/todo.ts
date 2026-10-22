// M23 §1: todo_write — the long-task execution engine's task-state memory.
//
// Dual write: the tool RESULT content is the formatted board (it lives in the
// conversation, so it is the authoritative in-context task state the model
// works from), and a human-readable copy lands on disk at planFilePath
// (default <workspaceRoot>/.wudao/plan.md). The disk copy is a convenience —
// write failures degrade to a warning appended to the result, never isError
// (fail-open on the COPY, fail-closed on argument validation).
//
// Board contract (binding, every consumer keys off these exports — never
// scatter raw string compares): the first line of the result is exactly
// `[todo board N/M done]`; every item line is prefixed `☑ `/`◐ `/`☐ `. An
// in_progress line carries the item's activeForm in place of its content when
// one is given — the line FORMAT never changes, only the text on the line.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { buildTool } from "../tool.js";

export const TODO_BOARD_PREFIX = "[todo board";

/** Item-line prefixes, by status — the single source for renderers. */
export const TODO_LINE_MARKS = {
  done: "☑ ",
  inProgress: "◐ ",
  pending: "☐ ",
} as const;

const DONE_MARK = TODO_LINE_MARKS.done;
const IN_PROGRESS_MARK = TODO_LINE_MARKS.inProgress;
const PENDING_MARK = TODO_LINE_MARKS.pending;
const MAX_ITEMS = 50;
const MAX_CONTENT_CHARS = 200;

const STATUSES = ["pending", "in_progress", "done"] as const;
type TodoStatus = (typeof STATUSES)[number];

export interface TodoItem {
  readonly content: string;
  readonly status: TodoStatus;
  /** Present-tense label ("Adding pagination") — replaces content on the
   *  in_progress line only; never present on pending/done items (stripped
   *  during validation — carrying one there is ignored, not an error). */
  readonly activeForm?: string;
}

export interface ParsedTodoBoard {
  readonly done: number;
  readonly total: number;
  readonly incomplete: number;
  readonly lines: string[];
}

/** Parse a board message (tool result or restored user message). Returns
 *  undefined unless the content carries a well-formed `[todo board N/M done]`
 *  header line — the single recognizer for loop gates, compaction
 *  re-injection, and the TUI. */
export function parseTodoBoard(content: string): ParsedTodoBoard | undefined {
  const firstNewline = content.indexOf("\n");
  const header = (firstNewline === -1 ? content : content.slice(0, firstNewline)).trimEnd();
  const match = /^\[todo board (\d+)\/(\d+) done\]/.exec(header);
  if (!match) return undefined;
  const done = Number(match[1]);
  const total = Number(match[2]);
  const lines = (firstNewline === -1 ? [] : content.slice(firstNewline + 1).split("\n"))
    .filter((l) => l.startsWith(DONE_MARK) || l.startsWith(IN_PROGRESS_MARK) || l.startsWith(PENDING_MARK));
  // The header is the canonical count (it survives even if item lines were
  // trimmed); incomplete = pending + in_progress.
  return { done, total, incomplete: total - done, lines };
}

function itemMark(status: TodoStatus): string {
  if (status === "done") return DONE_MARK;
  if (status === "in_progress") return IN_PROGRESS_MARK;
  return PENDING_MARK;
}

/** Text shown on an item line: activeForm when in_progress carries one,
 *  content otherwise (the in_progress-activeForm substitution is the whole
 *  of M26 P4 — marks and line shapes are untouched). */
function displayText(item: TodoItem): string {
  return item.status === "in_progress" && item.activeForm !== undefined ? item.activeForm : item.content;
}

interface ValidatedTodos {
  readonly items: readonly TodoItem[];
}

/** Deep argument validation — fail-closed: any violation returns an error
 *  message and the board is NOT written. */
function validateTodos(todos: unknown): ValidatedTodos | { error: string } {
  if (!Array.isArray(todos)) return { error: "todos must be an array" };
  if (todos.length > MAX_ITEMS) return { error: `too many todos: ${todos.length} (max ${MAX_ITEMS})` };
  const items: TodoItem[] = [];
  let inProgress = 0;
  for (const raw of todos) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return { error: "each todo must be an object {content, status}" };
    }
    const record = raw as Record<string, unknown>;
    const content = record["content"];
    const status = record["status"];
    if (typeof content !== "string" || content.length === 0) {
      return { error: "todo.content must be a non-empty string" };
    }
    if (content.length > MAX_CONTENT_CHARS) {
      return { error: `todo.content too long: ${content.length} chars (max ${MAX_CONTENT_CHARS})` };
    }
    if (typeof status !== "string" || !(STATUSES as readonly string[]).includes(status)) {
      return { error: `todo.status must be one of ${STATUSES.join(" | ")}` };
    }
    const typed = status as TodoStatus;
    if (typed === "in_progress") inProgress += 1;
    if (inProgress > 1) {
      return { error: "at most one todo may be in_progress (work items ONE at a time)" };
    }
    // activeForm is only meaningful while the item is being worked; on
    // pending/done items it is dropped (ignore, never error).
    const activeFormRaw = record["activeForm"];
    if (activeFormRaw !== undefined) {
      if (typeof activeFormRaw !== "string" || activeFormRaw.length === 0) {
        return { error: "todo.activeForm must be a non-empty string" };
      }
      if (activeFormRaw.length > MAX_CONTENT_CHARS) {
        return { error: `todo.activeForm too long: ${activeFormRaw.length} chars (max ${MAX_CONTENT_CHARS})` };
      }
      if (typed === "in_progress") {
        items.push({ content, status: typed, activeForm: activeFormRaw });
        continue;
      }
    }
    items.push({ content, status: typed });
  }
  return { items };
}

function formatBoard(items: readonly TodoItem[]): string {
  const done = items.filter((t) => t.status === "done").length;
  const lines = items.map((t) => `${itemMark(t.status)}${displayText(t)}`);
  return [`[todo board ${done}/${items.length} done]`, ...lines].join("\n");
}

function formatPlan(items: readonly TodoItem[], completedAt: ReadonlyMap<string, Date>): string {
  const done = items.filter((t) => t.status === "done").length;
  const header = `# plan · updated ${new Date().toISOString()} · ${done}/${items.length} done`;
  const body = items.map((t) => {
    if (t.status !== "done") return `${itemMark(t.status)}${displayText(t)}`;
    const at = completedAt.get(t.content);
    return at ? `${DONE_MARK}${t.content} · done ${at.toISOString()}` : `${DONE_MARK}${t.content}`;
  });
  return [header, "", ...body, ""].join("\n");
}

// the upstream format-style contract description: the rules are stated once and the three
// <example> blocks (create the board / advance it / skip with a reason) show
// the exact payloads. Static string — byte-stable for prefix caching.
const TODO_DESCRIPTION = `Create or replace the task board (full replacement, idempotent). This is the task-state memory: for any task needing more than ~3 steps, create the board when work starts, keep exactly ONE item in_progress, and update the board immediately after every step. The run is not finished while items are incomplete.

Contract:
- Exactly one item may be in_progress at a time.
- Mark an item done only after its tests or verification actually pass — never before.
- To skip an item, keep it on the board with the reason appended to its content.
- activeForm (optional, in_progress only): the present-tense label to show while working the item (e.g. "Adding pagination"); it replaces the line text on the board and is ignored on pending/done items.

<example>
Creating the board at task start — every step listed, first one in_progress:
todos: [
  { "content": "Read parser source", "status": "in_progress", "activeForm": "Reading parser source" },
  { "content": "Write tokenizer tests", "status": "pending" },
  { "content": "Fix off-by-one in tokenizer", "status": "pending" }
]
</example>

<example>
Advancing after a step lands — the finished item stays done, the next takes in_progress with its activeForm:
todos: [
  { "content": "Read parser source", "status": "done" },
  { "content": "Write tokenizer tests", "status": "in_progress", "activeForm": "Writing tokenizer tests" },
  { "content": "Fix off-by-one in tokenizer", "status": "pending" }
]
</example>

<example>
Skipping a step — the reason rides in the content and the item is never silently dropped:
todos: [
  { "content": "Read parser source", "status": "done" },
  { "content": "Write tokenizer tests — skipped: covered by the existing fixture suite instead", "status": "done" },
  { "content": "Fix off-by-one in tokenizer", "status": "in_progress", "activeForm": "Fixing off-by-one in tokenizer" }
]
</example>`;

export function createTodoTool(options: { workspaceRoot?: string; planFilePath?: string }) {
  // Run-scoped completion timestamps: an item first seen as done gets stamped
  // NOW; the stamp survives later board updates (full-replacement semantics).
  const completedAt = new Map<string, Date>();
  const planFilePath = options.planFilePath ?? (options.workspaceRoot !== undefined
    ? join(options.workspaceRoot, ".wudao", "plan.md")
    : undefined);

  return buildTool({
    name: "todo_write",
    description: TODO_DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          description: "Full list of todo items (replaces the previous board).",
          items: {
            type: "object",
            properties: {
              content: { type: "string", description: "Short task description (<= 200 chars)." },
              status: { type: "string", description: '"pending" | "in_progress" | "done"' },
              activeForm: {
                type: "string",
                description: 'Present-tense label shown on the in_progress line (e.g. "Adding pagination"); ignored on pending/done items. <= 200 chars.',
              },
            },
            required: ["content", "status"],
          },
        },
      },
      required: ["todos"],
      additionalProperties: false,
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    async execute({ todos }) {
      const validated = validateTodos(todos);
      if ("error" in validated) return { content: `todo_write invalid arguments: ${validated.error}`, isError: true };

      for (const item of validated.items) {
        if (item.status === "done" && !completedAt.has(item.content)) {
          completedAt.set(item.content, new Date());
        }
      }
      const board = formatBoard(validated.items);

      if (planFilePath === undefined) return { content: board };
      try {
        await mkdir(dirname(planFilePath), { recursive: true });
        await writeFile(planFilePath, formatPlan(validated.items, completedAt), "utf8");
        return { content: board };
      } catch (err) {
        // The disk file is a copy; the context board is authoritative.
        const message = err instanceof Error ? err.message : String(err);
        return { content: `${board}\n(warning: plan.md write failed: ${message})` };
      }
    },
  });
}
