// The todo-board line marks — a mirror of core's TODO_LINE_MARKS
// (packages/core/src/tools/todo.ts). Duplicated because the web package is
// deliberately workspace-dep-free (a pure protocol consumer); the shapes
// arrive over the wire, the marks classify the rendered lines.
export const TODO_LINE_MARKS = {
  done: "☑ ",
  inProgress: "◐ ",
  pending: "☐ ",
} as const;

export type BoardLineClass = "done" | "wip" | "todo";

/** Classify one board line by its leading mark. */
export function boardLineClass(line: string): BoardLineClass {
  if (line.startsWith(TODO_LINE_MARKS.done)) return "done";
  if (line.startsWith(TODO_LINE_MARKS.inProgress)) return "wip";
  return "todo";
}
