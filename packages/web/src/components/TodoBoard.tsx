// TodoBoard — 墨线 T11 (spec §2 任务板): the checklist's ink-line shell —
// .todo > .todo-bar (a 2px accent progress line whose inline width is
// done/total) + .todo-item rows (.todo-box 16px square checkbox [.done →
// accent-weak fill + IconCheck] + a label span). The ☑/◐/☐ text marks
// retire into the checkbox; the classification itself still lives in
// src/board.ts (the core TODO_LINE_MARKS mirror) — this stays the
// presentational 20-line shell it always was.
import React from "react";
import { TODO_LINE_MARKS, boardLineClass } from "../board.js";
import { IconCheck } from "./icons.js";

/** Strip one leading board mark (glyph + its space) — the checkbox replaces
 *  the glyph; an unmarked line classifies pending and renders whole. */
function stripMark(line: string): string {
  for (const mark of [TODO_LINE_MARKS.done, TODO_LINE_MARKS.inProgress, TODO_LINE_MARKS.pending]) {
    if (line.startsWith(mark)) return line.slice(mark.length);
  }
  return line;
}

export function TodoBoard({ done, total, lines }: {
  done: number;
  total: number;
  lines: readonly string[];
}): React.JSX.Element {
  const pct = total === 0 ? 0 : (done / total) * 100;
  return (
    <div className="todo">
      <div
        className="todo-bar"
        role="progressbar"
        aria-label={`${done}/${total}`}
        aria-valuenow={done}
        aria-valuemin={0}
        aria-valuemax={total}
        style={{ width: `${pct}%` }}
      />
      {lines.map((line, i) => {
        const state = boardLineClass(line);
        return (
          <div key={i} className="todo-item">
            <span className={`todo-box${state === "done" ? " done" : ""}`}>
              {state === "done" ? <IconCheck size={12} /> : null}
            </span>
            <span>{stripMark(line)}</span>
          </div>
        );
      })}
    </div>
  );
}
