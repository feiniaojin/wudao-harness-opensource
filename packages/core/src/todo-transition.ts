// 拆分外提（借鉴弧 B2 收口）：todo_write 迁移判定的纯 halves——从 loop.ts
// 原样外提（M63-B 的 gateTodoTransition 内核），loop 保留门控/钩子调用面。
// 依赖方向：todo-transition → tools/todo（无环）。
import type { AgentMessage } from "./types.js";
import { TODO_LINE_MARKS, parseTodoBoard } from "./tools/todo.js";

/** M63-B: TaskCreated/TaskCompleted decision — blocking refuses the
 *  todo_write transition (the model sees an error tool result naming the
 *  reason). void/"allow" = the write proceeds. */
export type TaskHookDecision = void | "allow" | { block: true; reason?: string };

/** M63-B: The todo items a transition carries (content strings — the board's
 *  own identity for an item). */
export interface TaskTransitionItems {
  readonly created: readonly string[];
  readonly completed: readonly string[];
}

/** One board item as the transition matcher sees it. */
export interface TodoItemLike {
  readonly content: string;
  readonly status: string;
}

/** The raw todos argument → normalized items (junk rows dropped; a missing/
 *  non-string status reads "pending" — schema validation owns hard errors). */
export function parseTodoItems(raw: readonly unknown[]): TodoItemLike[] {
  const items: TodoItemLike[] = [];
  for (const t of raw) {
    if (t !== null && typeof t === "object" && typeof (t as Record<string, unknown>)["content"] === "string") {
      const rec = t as Record<string, unknown>;
      items.push({ content: rec["content"] as string, status: typeof rec["status"] === "string" ? rec["status"] : "pending" });
    }
  }
  return items;
}

/** The LAST board message in history → its items (display text + status); an
 *  empty list when no board exists yet. */
export function lastBoardItems(messages: readonly AgentMessage[]): { status: string; text: string }[] {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m?.role !== "tool") continue;
    const parsed = parseTodoBoard(m.content);
    if (parsed === undefined) continue;
    const items: { status: string; text: string }[] = [];
    for (const line of parsed.lines) {
      const mark = line.slice(0, 2);
      const status = mark === TODO_LINE_MARKS.done ? "done" : mark === TODO_LINE_MARKS.inProgress ? "in_progress" : "pending";
      items.push({ status, text: line.slice(2) });
    }
    return items; // the LAST board in history is the current one
  }
  return [];
}

/**
 * Old board recovery (R1 fix) + the transition delta. The board's DISPLAY text
 * is not always the item content: an in_progress line renders activeForm IN
 * PLACE of content (tools/todo.ts), so the canonical pending → in_progress →
 * done flow changes the line text mid-flow. Two-tier matching:
 *   (a) display-text key: pending/done lines preserve content verbatim;
 *   (b) POSITIONAL fallback for old in_progress lines only — the only
 *       spelling whose text may differ from the content. A pending/done old
 *       item with different text at the same index is a REMOVED item (the new
 *       text is a created one), not a rename.
 */
export function todoTransitionDelta(
  oldItems: readonly { status: string; text: string }[],
  newItems: readonly TodoItemLike[],
): TaskTransitionItems {
  const oldStatusByText = new Map(oldItems.map((it) => [it.text, it.status]));
  const oldStatusAt = (index: number): string | undefined => oldItems[index]?.status;
  const knownStatus = (item: TodoItemLike, index: number): string | undefined => {
    const byText = oldStatusByText.get(item.content);
    if (byText !== undefined) return byText;
    // Positional pairing, in_progress old lines only (activeForm masking).
    if (oldStatusAt(index) === "in_progress") return "in_progress";
    return undefined;
  };
  const created: string[] = [];
  const completed: string[] = [];
  newItems.forEach((it, index) => {
    const prev = knownStatus(it, index);
    if (prev === undefined) {
      created.push(it.content);
      return;
    }
    if (it.status === "done" && prev !== "done") completed.push(it.content);
  });
  return { created, completed };
}

/** The task-hook consult: a throwing hook degrades to allow; a block returns
 *  its reason (the caller refuses the write with the reason in the result). */
export async function consultTaskHook(
  hook: ((items: readonly string[], b: { total: number; done: number }) => Promise<TaskHookDecision> | TaskHookDecision) | undefined,
  items: readonly string[],
  board: { total: number; done: number },
): Promise<string | undefined> {
  if (hook === undefined || items.length === 0) return undefined;
  let decision: TaskHookDecision;
  try {
    decision = await hook(items, board);
  } catch {
    return undefined; // throwing task hook → allow the write
  }
  if (typeof decision === "object" && decision.block) {
    return decision.reason ?? "blocked by task hook";
  }
  return undefined;
}
